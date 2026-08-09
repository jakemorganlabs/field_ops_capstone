import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { fsObjectStore } from "../src/objectstore.js";
import { ingestFiles } from "../src/ingest/ingest.js";
import { buildIntentQueries, retrieveIntent, type Intent, type IntentResult, type RetrievalCfg } from "../src/retrieval.js";
import { runEstimator, type Deps as EstimatorDeps, type BillOfMaterials, type ComputedTotals } from "../src/agents/estimator.js";
import { runWriter, type Deps as WriterDeps, type ProposalDocument } from "../src/agents/writer.js";
import { runPipeline } from "../src/pipeline.js";
import { findNumericalDrift } from "../src/drift_validator.js";
import type { ProjectSpec } from "../src/qualification.js";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const embedCfg = {
  baseUrl: process.env.EMBEDDING_BASE_URL!,
  modelId: process.env.EMBEDDING_MODEL_ID!,
  dimensions: Number(process.env.EMBEDDING_DIMENSIONS || "1536"),
  apiKey: process.env.DEEPINFRA_API_KEY!,
};

if (!embedCfg.baseUrl || !embedCfg.modelId || !embedCfg.apiKey) {
  console.error("EMBEDDING_BASE_URL, EMBEDDING_MODEL_ID, and DEEPINFRA_API_KEY are required");
  process.exit(1);
}

const objectStoreDir = process.env.OBJECT_STORE_DIR || resolve("objects");
const store = fsObjectStore(objectStoreDir);

const pool = new Pool({ connectionString: databaseUrl });

async function loadJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}

async function loadRetrievalConfig(): Promise<{ floors: Record<Intent, number>; maxChunks: number }> {
  const text = await readFile(join(__dirname, "..", "config", "retrieval.json"), "utf-8");
  const parsed = JSON.parse(text);
  return {
    floors: parsed.floors,
    maxChunks: parsed.max_chunks_per_query ?? 20,
  };
}

async function loadRateMap(): Promise<Record<string, string>> {
  const text = await readFile(join(__dirname, "..", "config", "labor_rates.json"), "utf-8");
  return JSON.parse(text);
}

async function loadTaxRate(): Promise<string> {
  const text = await readFile(join(__dirname, "..", "config", "tax.json"), "utf-8");
  const parsed = JSON.parse(text);
  return parsed.rate;
}

async function resetState(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("TRUNCATE document, chunk, run, spec, audit, dead_letter RESTART IDENTITY CASCADE");
  } finally {
    client.release();
  }
}

async function ingestCorpus(): Promise<void> {
  const corpusDir = resolve("fixtures/synthetic_corpus");
  await ingestFiles([join(corpusDir, "cat6a_pricing.md")], {
    docType: "spec_sheet",
    source: "synthetic_corpus",
    region: "CA",
    date: "2025-11-01",
    pool,
    store,
    embedCfg,
  });
  await ingestFiles([join(corpusDir, "labor_rates.md")], {
    docType: "wage_schedule",
    source: "synthetic_corpus",
    region: "CA",
    date: "2025-11-01",
    pool,
    store,
    embedCfg,
  });
  await ingestFiles([join(corpusDir, "code_reference.md")], {
    docType: "code",
    source: "synthetic_corpus",
    region: "CA",
    date: "2025-11-01",
    pool,
    store,
    embedCfg,
  });
  await ingestFiles([join(corpusDir, "proposal_cat6a.md")], {
    docType: "proposal",
    source: "synthetic_corpus",
    region: "CA",
    date: "2025-11-01",
    pool,
    store,
    embedCfg,
  });
}

let runCounter = 0;

async function createRun(): Promise<string> {
  runCounter += 1;
  const hash = `writer-smoke-hash-${runCounter}`;
  const result = await pool.query("INSERT INTO run (intake_hash, status) VALUES ($1, 'pending') RETURNING id", [
    hash,
  ]);
  return result.rows[0].id;
}

async function buildEvidence(spec: ProjectSpec, retrievalCfg: RetrievalCfg): Promise<Record<Intent, IntentResult>> {
  const queries = buildIntentQueries(spec);
  const intents: Intent[] = ["similar_projects", "manufacturer_specs", "code_references"];
  const evidence = {} as Record<Intent, IntentResult>;

  const filters: Record<Intent, { doc_type?: string; region?: string }> = {
    similar_projects: { doc_type: "proposal", region: spec.region },
    manufacturer_specs: { doc_type: "spec_sheet", region: spec.region },
    code_references: { doc_type: "code", region: spec.region },
  };

  for (const intent of intents) {
    evidence[intent] = await retrieveIntent(intent, queries[intent], filters[intent], retrievalCfg);
  }

  return evidence;
}

async function fetchSpecForRun(runId: string): Promise<ProjectSpec> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT * FROM spec WHERE id = (SELECT spec_id FROM run WHERE id = $1) LIMIT 1",
      [runId]
    );
    if (!result.rowCount || result.rowCount === 0) {
      throw new Error(`spec not found for run ${runId}`);
    }
    const row = result.rows[0];
    return {
      project_name: row.project_name,
      client_name: row.client_name,
      location: row.location,
      region: row.region,
      start_date: row.start_date,
      end_date: row.end_date,
      scope: row.scope,
      materials: Array.isArray(row.materials) ? row.materials : JSON.parse(row.materials ?? "[]"),
      labor: Array.isArray(row.labor) ? row.labor : JSON.parse(row.labor ?? "[]"),
      constraints: Array.isArray(row.constraints) ? row.constraints : JSON.parse(row.constraints ?? "[]"),
      notes: row.notes,
      raw_text: row.raw_text,
    };
  } finally {
    client.release();
  }
}

async function runFullChain(): Promise<{ runId: string; proposal: ProposalDocument; bom: BillOfMaterials; totals: ComputedTotals; spec: ProjectSpec }> {
  console.log("=== full chain on 40-drop intake ===");
  const intake = await loadJson("fixtures/eval_cases/happy_spec.json");
  const runId = await createRun();
  await runPipeline(runId, intake, pool);

  const spec = await fetchSpecForRun(runId);
  const retrievalCfg = await loadRetrievalConfig();
  const rateMap = await loadRateMap();
  const taxRate = await loadTaxRate();
  const evidence = await buildEvidence(spec, { pool, embedCfg, ...retrievalCfg });

  const estimatorDeps: EstimatorDeps = {
    pool,
    retrievalCfg: { pool, embedCfg, ...retrievalCfg },
    rateMap,
    taxRate,
    runId,
  };
  const estimatorOutcome = await runEstimator(spec, evidence, estimatorDeps);

  const writerDeps: WriterDeps = { pool, runId, taxRate };
  const proposal = await runWriter(estimatorOutcome.bom, estimatorOutcome.totals, evidence.similar_projects, writerDeps);

  console.log(JSON.stringify({ runId, total: proposal.total, assumptions: proposal.assumptions.length }, null, 2));

  if (proposal.total !== estimatorOutcome.totals.total) {
    throw new Error(`proposal total ${proposal.total} does not match computed total ${estimatorOutcome.totals.total}`);
  }

  return { runId, proposal, bom: estimatorOutcome.bom, totals: estimatorOutcome.totals, spec };
}

async function runDriftCase(baseline: { proposal: ProposalDocument; bom: BillOfMaterials; totals: ComputedTotals; spec: ProjectSpec }): Promise<void> {
  console.log("=== corrupted total triggers drift validator ===");
  const corrupted = JSON.parse(JSON.stringify(baseline.proposal)) as ProposalDocument;
  corrupted.total = "999999.99";
  const findings = findNumericalDrift(corrupted, baseline.bom, baseline.totals, baseline.spec);
  console.log(JSON.stringify({ findings }, null, 2));
  if (findings.length === 0) {
    throw new Error("drift validator did not catch corrupted total");
  }
  const totalFinding = findings.find((f) => f.field === "total");
  if (!totalFinding) {
    throw new Error("drift validator did not report total field");
  }
}

async function runAssumptionCase(): Promise<void> {
  console.log("=== BOM with three assumptions surfaces all three ===");
  const intake = await loadJson("fixtures/eval_cases/happy_spec.json");
  const runId = await createRun();
  await runPipeline(runId, intake, pool);

  const spec = await fetchSpecForRun(runId);
  const taxRate = await loadTaxRate();
  const retrievalCfg = await loadRetrievalConfig();
  const evidence = await buildEvidence(spec, { pool, embedCfg, ...retrievalCfg });

  const bom: BillOfMaterials = {
    run_id: runId,
    lines: [
      { item: "Assumed cable", quantity: "40", unit_cost: "0.00", assumption: true, note: "price pending vendor quote" },
      { item: "Assumed bracket", quantity: "40", unit_cost: "0.00", assumption: true, note: "mount type not confirmed" },
      { item: "Assumed label", quantity: "40", unit_cost: "0.00", assumption: true, note: "label format TBD" },
    ],
  };
  const totals: ComputedTotals = {
    materials: "0.00",
    labor: "0.00",
    tax: "0.00",
    total: "0.00",
    includes_assumptions: true,
  };

  const writerDeps: WriterDeps = { pool, runId, taxRate };
  const proposal = await runWriter(bom, totals, evidence.similar_projects, writerDeps);

  console.log(JSON.stringify({ runId, assumptions: proposal.assumptions }, null, 2));

  const expected = ["Assumed cable", "Assumed bracket", "Assumed label"];
  for (const item of expected) {
    const found = proposal.assumptions.some((a) => a.toLowerCase().includes(item.toLowerCase()));
    if (!found) {
      throw new Error(`missing assumption for ${item}`);
    }
  }
}

async function main(): Promise<void> {
  try {
    await resetState();
    await ingestCorpus();
    const baseline = await runFullChain();
    await runDriftCase(baseline);
    await runAssumptionCase();
    console.log("=== writer smoke passed ===");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
