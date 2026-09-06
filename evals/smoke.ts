import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { config } from "dotenv";
import { createPool } from "../src/db.js";
import { retrieveIntent, type Intent } from "../src/retrieval.js";
import { runMigrations, cleanDatabase, seedCorpus } from "./seed.js";

config();

const DATABASE_URL = process.env.DATABASE_URL ?? "";

// The smoke run measures retrieval recall for one answerable case and nothing
// else. It writes to its own results file so it never overwrites the full
// 50-case figures in evals/results.json. The gate and badge read the same path
// through EVAL_RESULTS_PATH.
const RESULTS_PATH = process.env.EVAL_RESULTS_PATH ?? "evals/smoke_results.json";

export const SMOKE_UNMEASURED = [
  "structural",
  "semantic",
  "reviewer",
  "escalation",
  "injection",
  "ingest",
  "refusal",
] as const;

interface SmokeCase {
  scenario: string;
  intake: {
    project_name: string;
    client_name: string;
    location: string;
    region: string;
    scope: string;
    materials: string[];
    labor: string[];
    constraints: string[];
    confidence: number;
  };
  expected_route: string;
  gold_chunks_per_intent: Record<string, string[]>;
}

async function loadSmokeCase(): Promise<SmokeCase> {
  const text = await readFile("fixtures/eval_cases/answerable.json", "utf-8");
  const parsed = JSON.parse(text) as SmokeCase[];
  return parsed[0];
}

async function buildRetrievalCfg(pool: ReturnType<typeof createPool>) {
  const cfgText = await readFile("config/retrieval.json", "utf-8");
  const cfg = JSON.parse(cfgText) as { floors: Record<string, number>; max_chunks_per_query: number };
  return {
    pool,
    embedCfg: {
      baseUrl: process.env.EMBEDDING_BASE_URL ?? "",
      modelId: process.env.EMBEDDING_MODEL_ID ?? "",
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
      apiKey: process.env.DEEPINFRA_API_KEY ?? "",
    },
    floors: cfg.floors,
    maxChunks: cfg.max_chunks_per_query,
  };
}

function buildIntentQueries(spec: SmokeCase["intake"]): Record<Intent, string> {
  const scope = spec.scope;
  const region = spec.region;
  return {
    similar_projects: `${scope} ${region}`,
    manufacturer_specs: `${spec.materials.join(" ")} ${region}`,
    code_references: `${spec.constraints.join(" ")} ${region} code`,
  };
}

function commitHash(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<void> {
  if (!DATABASE_URL.includes("fieldops_eval")) {
    throw new Error("Refusing to run: DATABASE_URL must contain 'fieldops_eval'");
  }

  const pool = createPool();
  await runMigrations(pool);
  await cleanDatabase(pool);
  await seedCorpus(pool);

  const smokeCase = await loadSmokeCase();
  const retrievalCfg = await buildRetrievalCfg(pool);
  const queries = buildIntentQueries(smokeCase.intake);

  const retrieval: Array<{ intent: string; recall: number; scored: number; eligible: number; passed: boolean }> = [];
  const retrieved: Record<string, { source: string; chunk_id: string; score: number }[]> = {};

  for (const intent of ["similar_projects", "manufacturer_specs", "code_references"] as Intent[]) {
    const result = await retrieveIntent(intent, queries[intent], {}, retrievalCfg);
    retrieved[intent] = result.chunks.map((c) => ({
      source: c.source?.replace(/^eval_/, "") ?? "",
      chunk_id: c.chunk_id,
      score: c.score,
    }));

    const gold = smokeCase.gold_chunks_per_intent[intent] ?? [];
    const retrievedSources = new Set(retrieved[intent].map((c) => c.source));
    const hits = gold.filter((g) => retrievedSources.has(g)).length;
    const recall = gold.length === 0 ? 1 : hits / gold.length;
    retrieval.push({ intent, recall, scored: 1, eligible: 1, passed: recall >= 0.8 });
  }

  const allPassed = retrieval.every((r) => r.passed);

  // Only what this run computed. No stage of the agent chain runs here, so
  // there is no structural, semantic, reviewer, escalation, injection, ingest,
  // or refusal figure to report.
  const results = {
    mode: "smoke",
    commit_hash: commitHash(),
    timestamp: new Date().toISOString(),
    counts: { answerable: 1, near_miss: 0, no_evidence: 0, adversarial: 0 },
    measured: ["retrieval"],
    unmeasured: [...SMOKE_UNMEASURED],
    retrieval,
    retrieved,
    samples: [],
  };

  await writeFile(RESULTS_PATH, JSON.stringify(results, null, 2) + "\n");
  console.log(
    JSON.stringify({ event: "smoke_eval_complete", results_file: RESULTS_PATH, retrieval, passed: allPassed, unmeasured: SMOKE_UNMEASURED })
  );
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
