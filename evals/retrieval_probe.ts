import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import { createPool } from "../src/db.js";
import { buildIntentQueries, retrieveIntent, type Intent } from "../src/retrieval.js";
import type { ProjectSpec } from "../src/qualification.js";
import { runMigrations, cleanDatabase, seedCorpus } from "./seed.js";
import type { EvalCase } from "./metrics/types.js";

config();

/**
 * Retrieval-only probe. Seeds the eval corpus, then for every case the full
 * eval would score for recall (expected_route proceed with gold sources) it
 * builds the same fixed intent queries the pipeline builds and scores recall
 * the same way evals/metrics/retrieval.ts does. No model call is made, so this
 * costs embeddings only and runs in under a minute.
 *
 * The full eval derives its queries from the extracted spec rather than the
 * intake, so this is a close proxy for the retrieval metric, not the metric.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const INTENTS: Intent[] = ["similar_projects", "manufacturer_specs", "code_references"];

interface CaseResult {
  scenario: string;
  project: string;
  intent: Intent;
  gold: string[];
  hits: string[];
  misses: string[];
  retrievedSources: string[];
  passed: boolean;
}

async function loadCases(): Promise<EvalCase[]> {
  const files = ["answerable", "near_miss", "no_evidence", "adversarial"];
  const cases: EvalCase[] = [];
  for (const file of files) {
    const text = await readFile(`fixtures/eval_cases/${file}.json`, "utf-8");
    cases.push(...(JSON.parse(text) as EvalCase[]));
  }
  return cases;
}

async function main(): Promise<void> {
  if (!DATABASE_URL.includes("fieldops_eval")) {
    throw new Error("Refusing to run: DATABASE_URL must contain 'fieldops_eval'");
  }
  const skipSeed = process.env.PROBE_SKIP_SEED === "1";

  const pool = createPool();
  if (!skipSeed) {
    await runMigrations(pool);
    await cleanDatabase(pool);
    await seedCorpus(pool);
  }

  const retrievalJson = JSON.parse(await readFile("config/retrieval.json", "utf-8")) as {
    floors: Record<Intent, number>;
    max_chunks_per_query: number;
  };
  const thresholds = JSON.parse(await readFile("evals/thresholds.json", "utf-8")) as {
    recall_at_k: Record<string, number>;
  };
  const cfg = {
    pool,
    embedCfg: {
      baseUrl: process.env.EMBEDDING_BASE_URL ?? "",
      modelId: process.env.EMBEDDING_MODEL_ID ?? "",
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
      apiKey: process.env.DEEPINFRA_API_KEY ?? "",
    },
    floors: retrievalJson.floors,
    maxChunks: retrievalJson.max_chunks_per_query,
  };

  const cases = (await loadCases()).filter(
    (c) => c.expected_route === "proceed" && c.gold_chunks_per_intent && Object.keys(c.gold_chunks_per_intent).length > 0
  );

  const results: CaseResult[] = [];
  for (const evalCase of cases) {
    const queries = buildIntentQueries(evalCase.intake as ProjectSpec);
    for (const intent of INTENTS) {
      const gold = evalCase.gold_chunks_per_intent?.[intent] ?? [];
      if (gold.length === 0) continue;
      const result = await retrieveIntent(intent, queries[intent], {}, cfg);
      const sources = result.chunks.map((c) => c.source.replace(/^eval_/, ""));
      const sourceSet = new Set(sources);
      const hits = gold.filter((g) => sourceSet.has(g));
      const misses = gold.filter((g) => !sourceSet.has(g));
      const recall = hits.length / gold.length;
      results.push({
        scenario: evalCase.scenario,
        project: String(evalCase.intake.project_name ?? ""),
        intent,
        gold,
        hits,
        misses,
        retrievedSources: Array.from(sourceSet),
        passed: recall >= (thresholds.recall_at_k[intent] ?? 0.8),
      });
    }
  }

  const summary = INTENTS.map((intent) => {
    const rows = results.filter((r) => r.intent === intent);
    const passed = rows.filter((r) => r.passed).length;
    return { intent, recall: rows.length === 0 ? 0 : passed / rows.length, scored: rows.length, passed };
  });

  for (const r of results.filter((r) => !r.passed)) {
    console.log(
      JSON.stringify({ event: "retrieval_miss", scenario: r.scenario, project: r.project, intent: r.intent, missed: r.misses, retrieved: r.retrievedSources })
    );
  }
  console.log(JSON.stringify({ event: "retrieval_probe_complete", cases: cases.length, summary }));
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
