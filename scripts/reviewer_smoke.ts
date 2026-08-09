import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { fsObjectStore } from "../src/objectstore.js";
import { ingestFiles } from "../src/ingest/ingest.js";
import { reviewAndRegenerate, type Deps, ROUTING } from "../src/review_loop.js";
import { materialSubtotal, laborTotal, proposalTotal } from "../src/calculator.js";
import type { BillOfMaterials, ComputedTotals } from "../src/agents/estimator.js";
import type { ProposalDocument } from "../src/agents/writer.js";
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

async function loadRetrievalConfig(): Promise<{ floors: Record<string, number>; maxChunks: number }> {
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
    await client.query("TRUNCATE document, chunk, run, spec, audit, dead_letter, critique RESTART IDENTITY CASCADE");
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

async function fetchChunkIds(): Promise<{
  specSheet: { chunk_id: string; score: number }[];
  proposal: { chunk_id: string; score: number }[];
  code: { chunk_id: string; score: number }[];
}> {
  const client = await pool.connect();
  try {
    const result = await client.query(
      "SELECT id, doc_type FROM chunk WHERE source = $1 ORDER BY doc_type, chunk_index",
      ["synthetic_corpus"]
    );
    const byType: Record<string, string[]> = {};
    for (const row of result.rows) {
      byType[row.doc_type] = byType[row.doc_type] ?? [];
      byType[row.doc_type].push(row.id);
    }
    return {
      specSheet: (byType["spec_sheet"] ?? []).map((id) => ({ chunk_id: id, score: 0.9 })),
      proposal: (byType["proposal"] ?? []).map((id) => ({ chunk_id: id, score: 0.9 })),
      code: (byType["code"] ?? []).map((id) => ({ chunk_id: id, score: 0.9 })),
    };
  } finally {
    client.release();
  }
}

async function createSpecAndRun(
  spec: ProjectSpec,
  bom: BillOfMaterials,
  proposal: ProposalDocument,
  retrievalSets: Record<string, { chunk_id: string; score: number }[]>
): Promise<string> {
  const client = await pool.connect();
  try {
    const specResult = await client.query(
      `INSERT INTO spec (
        project_name, client_name, location, region, start_date, end_date,
        scope, materials, labor, constraints, notes, raw_text, confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id`,
      [
        spec.project_name ?? "",
        spec.client_name ?? null,
        spec.location ?? null,
        spec.region ?? null,
        spec.start_date ?? null,
        spec.end_date ?? null,
        spec.scope ?? "",
        JSON.stringify(spec.materials ?? []),
        JSON.stringify(spec.labor ?? []),
        JSON.stringify(spec.constraints ?? []),
        spec.notes ?? null,
        spec.raw_text ?? JSON.stringify(spec),
        0.95,
      ]
    );
    const specId = specResult.rows[0].id;

    const runResult = await client.query(
      `INSERT INTO run (intake_hash, status, spec_id, bom, proposal, retrieval_sets)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        `reviewer-smoke-${Date.now()}`,
        "running",
        specId,
        JSON.stringify(bom),
        JSON.stringify(proposal),
        JSON.stringify(retrievalSets),
      ]
    );
    return runResult.rows[0].id;
  } finally {
    client.release();
  }
}

function makeBaseSpec(): ProjectSpec {
  return {
    project_name: "Office Cat6A Retrofit",
    client_name: "Smoke Client",
    location: "Sacramento",
    region: "CA",
    scope: "Install forty Cat6A network drops in an office building",
    materials: ["Cat6A cable", "keystone jacks", "wall plates", "patch panel ports", "patch cords"],
    labor: ["electrician", "apprentice"],
    constraints: ["plenum rated cable", "firestop penetrations"],
  };
}

function makeBaseBOM(runId: string, chunkId: string): BillOfMaterials {
  return {
    run_id: runId,
    lines: [
      {
        item: "Cat6A plenum cable, 1000 ft box",
        quantity: "2",
        unit_cost: "189.00",
        citation: { chunk_id: chunkId, snippet: "Cat6A plenum cable, 1000 ft box: $189.00 per box" },
      },
      {
        item: "Cat6A keystone jack",
        quantity: "40",
        unit_cost: "8.50",
        citation: { chunk_id: chunkId, snippet: "Cat6A keystone jack: $8.50 each" },
      },
      {
        item: "Patch cord, 10 ft",
        quantity: "40",
        unit_cost: "5.00",
        citation: { chunk_id: chunkId, snippet: "Patch cord, 10 ft: $5.00 each" },
      },
      {
        item: "1-port wall plate",
        quantity: "40",
        unit_cost: "3.25",
        citation: { chunk_id: chunkId, snippet: "1-port wall plate: $3.25 each" },
      },
    ],
    labor: [
      { role: "electrician", hours: "60", rate_key: "electrician", citation: { chunk_id: chunkId, snippet: "Electrician: $75.00 per hour" } },
      { role: "apprentice", hours: "20", rate_key: "apprentice", citation: { chunk_id: chunkId, snippet: "Apprentice: $35.00 per hour" } },
    ],
  };
}

function computeTotals(bom: BillOfMaterials, rateMap: Record<string, string>, taxRate: string): ComputedTotals {
  const materials = materialSubtotal(bom.lines);
  const labor = bom.labor ? laborTotal(bom.labor, rateMap) : "0.00";
  const total = proposalTotal(materials, labor, taxRate);
  const base = parseFloat(materials) + parseFloat(labor);
  const tax = (base * parseFloat(taxRate)).toFixed(2);
  const includesAssumptions =
    bom.lines.some((l) => l.assumption === true) || (bom.labor?.some((l) => l.assumption === true) ?? false);
  return { materials, labor, tax, total, includes_assumptions: includesAssumptions };
}

function makeBaseProposal(runId: string, totals: ComputedTotals): ProposalDocument {
  return {
    run_id: runId,
    bom_id: runId,
    summary: "Proposal for forty Cat6A network drops.",
    assumptions: [],
    code_claims: [],
    total: totals.total,
  };
}

async function makeDeps(overrides?: {
  reviewer?: Deps["reviewer"];
  estimator?: Deps["estimator"];
  writer?: Deps["writer"];
}): Promise<Deps> {
  const retrievalCfg = await loadRetrievalConfig();
  return {
    pool,
    retrievalCfg: { pool, embedCfg, ...retrievalCfg },
    rateMap: await loadRateMap(),
    taxRate: await loadTaxRate(),
    ...overrides,
  };
}

async function caseMissingItemFixed(): Promise<void> {
  console.log("=== case 1: missing patch cord is routed to estimator and fixed ===");
  const chunks = await fetchChunkIds();
  const spec = makeBaseSpec();
  const chunkId = chunks.specSheet[0]?.chunk_id ?? "00000000-0000-0000-0000-000000000000";
  const rateMap = await loadRateMap();
  const taxRate = await loadTaxRate();
  const bom = makeBaseBOM("00000000-0000-0000-0000-000000000000", chunkId);
  const totals = computeTotals(bom, rateMap, taxRate);
  const proposal = makeBaseProposal("00000000-0000-0000-0000-000000000000", totals);

  const corruptedBom = JSON.parse(JSON.stringify(bom)) as BillOfMaterials;
  corruptedBom.lines = corruptedBom.lines.filter((l) => !l.item.includes("Patch cord"));

  const runId = await createSpecAndRun(spec, corruptedBom, proposal, {
    similar_projects: chunks.proposal,
    manufacturer_specs: chunks.specSheet,
    code_references: chunks.code,
  });

  let estimatorCalled = false;
  let secondReview = false;

  const deps = await makeDeps({
    reviewer: async (input) => {
      if (input.bom.lines.some((l) => l.item.includes("Patch cord"))) {
        secondReview = true;
        return { run_id: input.run_id, round: input.round, decision: "pass", issues: [] };
      }
      return {
        run_id: input.run_id,
        round: input.round,
        decision: "revise",
        issues: [
          {
            type: "missing_item",
            severity: "error",
            target_agent: "estimator",
            description: "Patch cord line is missing from the BOM",
            evidence_chunk_id: chunkId,
          },
        ],
      };
    },
    estimator: async (_spec, _evidence, _deps, issues) => {
      estimatorCalled = true;
      const fixed = JSON.parse(JSON.stringify(corruptedBom)) as BillOfMaterials;
      fixed.run_id = runId;
      if (issues.some((i) => i.includes("missing_item"))) {
        fixed.lines.push({
          item: "Patch cord, 10 ft",
          quantity: "40",
          unit_cost: "5.00",
          citation: { chunk_id: chunkId, snippet: "Patch cord, 10 ft: $5.00 each" },
        });
      }
      return {
        bom: fixed,
        verdicts: [],
        totals: computeTotals(fixed, _deps.rateMap, _deps.taxRate),
        evidence_rounds: 0,
      };
    },
    writer: async (_bom, _totals, _templates, _deps, _issues) => {
      return { ...proposal, run_id: runId, bom_id: runId, total: _totals.total };
    },
  });

  const state = await reviewAndRegenerate(runId, deps);

  if (!estimatorCalled) throw new Error("estimator was not called for missing_item");
  if (!secondReview) throw new Error("second review did not pass");
  if (state.status !== "passed") throw new Error(`expected passed, got ${state.status}`);
}

async function caseUnresolvableDefect(): Promise<void> {
  console.log("=== case 2: unresolvable defect escalates after two iterations ===");
  const chunks = await fetchChunkIds();
  const spec = makeBaseSpec();
  const chunkId = chunks.specSheet[0]?.chunk_id ?? "00000000-0000-0000-0000-000000000000";
  const rateMap = await loadRateMap();
  const taxRate = await loadTaxRate();
  const bom = makeBaseBOM("00000000-0000-0000-0000-000000000000", chunkId);
  const totals = computeTotals(bom, rateMap, taxRate);
  const proposal = makeBaseProposal("00000000-0000-0000-0000-000000000000", totals);

  const runId = await createSpecAndRun(spec, bom, proposal, {
    similar_projects: chunks.proposal,
    manufacturer_specs: chunks.specSheet,
    code_references: chunks.code,
  });

  let estimatorCalls = 0;

  const deps = await makeDeps({
    reviewer: async () => ({
      run_id: runId,
      round: 1,
      decision: "revise",
      issues: [
        {
          type: "regulatory_gap",
          severity: "error",
          target_agent: "estimator",
          description: "Unresolvable regulatory gap",
          evidence_chunk_id: chunkId,
        },
      ],
    }),
    estimator: async (_spec, _evidence, _deps) => {
      estimatorCalls += 1;
      return {
        bom,
        verdicts: [],
        totals,
        evidence_rounds: 0,
      };
    },
    writer: async () => proposal,
  });

  const state = await reviewAndRegenerate(runId, deps);

  if (state.iterations !== 2) throw new Error(`expected 2 iterations, got ${state.iterations}`);
  if (state.status !== "needs_review") throw new Error(`expected needs_review, got ${state.status}`);
  if (state.open_issues.length === 0) throw new Error("expected open issues to be attached");
  if (estimatorCalls !== 2) throw new Error(`expected 2 estimator calls, got ${estimatorCalls}`);
}

async function casePricingAnomalyRoutesToEstimator(): Promise<void> {
  console.log("=== case 3: pricing_anomaly routes to estimator, not writer ===");
  const chunks = await fetchChunkIds();
  const spec = makeBaseSpec();
  const chunkId = chunks.specSheet[0]?.chunk_id ?? "00000000-0000-0000-0000-000000000000";
  const rateMap = await loadRateMap();
  const taxRate = await loadTaxRate();
  const bom = makeBaseBOM("00000000-0000-0000-0000-000000000000", chunkId);
  const totals = computeTotals(bom, rateMap, taxRate);
  const proposal = makeBaseProposal("00000000-0000-0000-0000-000000000000", totals);

  const runId = await createSpecAndRun(spec, bom, proposal, {
    similar_projects: chunks.proposal,
    manufacturer_specs: chunks.specSheet,
    code_references: chunks.code,
  });

  let estimatorIssueText: string | null = null;

  const deps = await makeDeps({
    reviewer: async () => ({
      run_id: runId,
      round: 1,
      decision: "revise",
      issues: [
        {
          type: "pricing_anomaly",
          severity: "error",
          target_agent: "estimator",
          description: "Cable price is anomalous",
          evidence_chunk_id: chunkId,
        },
      ],
    }),
    estimator: async (_spec, _evidence, _deps, issues) => {
      estimatorIssueText = issues.join("; ");
      return {
        bom,
        verdicts: [],
        totals,
        evidence_rounds: 0,
      };
    },
    writer: async () => proposal,
  });

  await reviewAndRegenerate(runId, deps);

  if (!estimatorIssueText) throw new Error("estimator was not called for pricing_anomaly");
  if (!estimatorIssueText.includes("pricing_anomaly")) throw new Error("pricing_anomaly was not routed to estimator");
  if (ROUTING.pricing_anomaly.includes("writer")) throw new Error("routing table sends pricing_anomaly to writer");
}

async function caseReviewerPassBadCitation(): Promise<void> {
  console.log("=== case 4: reviewer pass with bad citation is caught by grounding gate ===");
  const chunks = await fetchChunkIds();
  const spec = makeBaseSpec();
  const chunkId = chunks.specSheet[0]?.chunk_id ?? "00000000-0000-0000-0000-000000000000";
  const rateMap = await loadRateMap();
  const taxRate = await loadTaxRate();
  const bom = makeBaseBOM("00000000-0000-0000-0000-000000000000", chunkId);
  const totals = computeTotals(bom, rateMap, taxRate);
  const proposal = makeBaseProposal("00000000-0000-0000-0000-000000000000", totals);

  const corruptedBom = JSON.parse(JSON.stringify(bom)) as BillOfMaterials;
  corruptedBom.lines[0].citation = {
    chunk_id: "11111111-1111-1111-1111-111111111111",
    snippet: "Cat6A plenum cable, 1000 ft box: $189.00 per box",
  };

  const runId = await createSpecAndRun(spec, corruptedBom, proposal, {
    similar_projects: chunks.proposal,
    manufacturer_specs: chunks.specSheet,
    code_references: chunks.code,
  });

  const deps = await makeDeps({
    reviewer: async () => ({
      run_id: runId,
      round: 1,
      decision: "pass",
      issues: [],
    }),
    estimator: async (_spec, _evidence, _deps) => ({
      bom: corruptedBom,
      verdicts: [],
      totals,
      evidence_rounds: 0,
    }),
    writer: async () => proposal,
  });

  await reviewAndRegenerate(runId, deps);

  const client = await pool.connect();
  let finalBom: BillOfMaterials;
  try {
    const result = await client.query("SELECT bom FROM run WHERE id = $1 LIMIT 1", [runId]);
    finalBom = result.rows[0].bom as BillOfMaterials;
  } finally {
    client.release();
  }

  const firstLine = finalBom.lines[0];
  if (firstLine.assumption !== true) throw new Error("grounding gate did not recast the bad citation as an assumption");
  if (firstLine.citation !== undefined) throw new Error("bad citation was not removed");
}

async function main(): Promise<void> {
  try {
    await resetState();
    await ingestCorpus();

    await caseMissingItemFixed();
    await caseUnresolvableDefect();
    await casePricingAnomalyRoutesToEstimator();
    await caseReviewerPassBadCitation();

    console.log("=== reviewer smoke passed ===");
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
