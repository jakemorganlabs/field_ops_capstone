import { describe, it, expect, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { reviewAndRegenerate, type Deps, type Issue } from "../src/review_loop.js";
import type { BillOfMaterials, ComputedTotals } from "../src/agents/estimator.js";
import type { ProposalDocument } from "../src/agents/writer.js";
import type { ProjectSpec } from "../src/qualification.js";
import type { IntentResult } from "../src/retrieval.js";

const databaseUrl = process.env.DATABASE_URL;

describe("review loop", { tags: ["db"] }, () => {
  if (!databaseUrl) {
    it.skip("DATABASE_URL not set", () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.query("DELETE FROM document WHERE external_id = 'review-loop-test-doc'");
    await pool.end();
  });

  beforeEach(async () => {
    const client = await pool.connect();
    try {
      await client.query("TRUNCATE run, spec, critique, audit RESTART IDENTITY CASCADE");
    } finally {
      client.release();
    }
  });

  const CHUNK_ID = "00000000-0000-0000-0000-000000000000";

  // The loop-cap test needs a citation that verifies, otherwise the grounding
  // gate recasts the line to an assumption, the BOM has no evidence-backed
  // line, and the refusal gate escalates in round one.
  async function seedChunk(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("DELETE FROM document WHERE external_id = 'review-loop-test-doc'");
      const doc = await client.query(
        `INSERT INTO document (external_id, source, doc_type, object_key, content_hash)
         VALUES ('review-loop-test-doc', 'review-loop-test', 'eval_document', 'review-loop-test/doc', 'review-loop-hash')
         RETURNING id`
      );
      await client.query(
        `INSERT INTO chunk (id, document_id, content_hash, chunk_index, embed_model, text, doc_type, source)
         VALUES ($1, $2, 'review-loop-hash', 0, 'test-model', 'Cat6A keystone jack: $8.50 each', 'eval_document', 'review-loop-test')`,
        [CHUNK_ID, doc.rows[0].id]
      );
    } finally {
      client.release();
    }
  }

  async function createRunWithState(bom: BillOfMaterials, proposal: ProposalDocument, withEvidence = false): Promise<string> {
    if (withEvidence) await seedChunk();
    const client = await pool.connect();
    try {
      const specResult = await client.query(
        `INSERT INTO spec (
          project_name, client_name, location, region, start_date, end_date,
          scope, materials, labor, constraints, notes, raw_text, confidence
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        RETURNING id`,
        [
          "Test Project",
          "Test Client",
          "Sacramento",
          "CA",
          null,
          null,
          "Install forty Cat6A drops",
          JSON.stringify(["Cat6A cable"]),
          JSON.stringify(["electrician"]),
          JSON.stringify([]),
          null,
          "raw",
          0.95,
        ]
      );
      const specId = specResult.rows[0].id;

      const runResult = await client.query(
        `INSERT INTO run (intake_hash, status, spec_id, bom, proposal, retrieval_sets)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          "review-loop-hash",
          "running",
          specId,
          JSON.stringify(bom),
          JSON.stringify(proposal),
          JSON.stringify({
            similar_projects: withEvidence ? [{ chunk_id: CHUNK_ID, score: 0.9 }] : [],
            manufacturer_specs: [],
            code_references: [],
          }),
        ]
      );
      return runResult.rows[0].id;
    } finally {
      client.release();
    }
  }

  function makeBom(): BillOfMaterials {
    return {
      run_id: "00000000-0000-0000-0000-000000000000",
      lines: [
        {
          item: "Cat6A keystone jack",
          quantity: "40",
          unit_cost: "8.50",
          citation: { chunk_id: "00000000-0000-0000-0000-000000000000", snippet: "keystone jack: $8.50 each" },
        },
      ],
    };
  }

  function makeProposal(): ProposalDocument {
    return {
      run_id: "00000000-0000-0000-0000-000000000000",
      bom_id: "00000000-0000-0000-0000-000000000000",
      summary: "Test proposal",
      assumptions: [],
      code_claims: [],
      total: "368.05",
    };
  }

  function makeDeps(overrides?: {
    reviewer?: Deps["reviewer"];
    estimator?: Deps["estimator"];
    writer?: Deps["writer"];
  }): Deps {
    return {
      pool,
      retrievalCfg: {
        pool,
        embedCfg: { baseUrl: "http://test", modelId: "test", dimensions: 4, apiKey: "test" },
        floors: { similar_projects: 0, manufacturer_specs: 0, code_references: 0 },
        maxChunks: 5,
      },
      rateMap: { electrician: "75.00" },
      taxRate: "0.0825",
      ...overrides,
    };
  }

  it("escalates a bill of materials with no evidence-backed line even when the reviewer passes", async () => {
    const bom: BillOfMaterials = {
      run_id: "00000000-0000-0000-0000-000000000000",
      lines: [{ item: "Walk-in freezer", quantity: "1", unit_cost: "0.00", assumption: true, note: "price not found in evidence" }],
      labor: [{ role: "refrigeration technician", hours: "0", rate_key: "technician", assumption: true }],
    };
    const proposal: ProposalDocument = {
      ...makeProposal(),
      assumptions: ["Walk-in freezer: price not found in evidence", "refrigeration technician"],
      total: "0.00",
    };
    const runId = await createRunWithState(bom, proposal);

    let reviewerCalls = 0;
    let estimatorCalls = 0;
    let writerCalls = 0;
    const deps = makeDeps({
      reviewer: async () => {
        reviewerCalls += 1;
        return { run_id: runId, round: reviewerCalls, decision: "pass", issues: [] };
      },
      estimator: async () => {
        estimatorCalls += 1;
        throw new Error("estimator must not run");
      },
      writer: async () => {
        writerCalls += 1;
        return proposal;
      },
    });

    const state = await reviewAndRegenerate(runId, deps);

    expect(state.status).toBe("needs_review");
    expect(state.iterations).toBe(0);
    expect(state.open_issues[0].description).toMatch(/No line in the bill of materials is backed by retrieved evidence/);
    expect(reviewerCalls).toBe(1);
    expect(estimatorCalls).toBe(0);
    expect(writerCalls).toBe(0);

    const client = await pool.connect();
    try {
      const run = await client.query("SELECT status, critique FROM run WHERE id = $1", [runId]);
      expect(run.rows[0].status).toBe("needs_review");
      expect(run.rows[0].critique.issues[0].severity).toBe("error");
      const critiques = await client.query("SELECT verdict FROM critique WHERE run_id = $1", [runId]);
      expect(critiques.rows).toEqual([{ verdict: "pass" }]);
    } finally {
      client.release();
    }
  });

  it("does not reach a third iteration", async () => {
    const bom = makeBom();
    const proposal = makeProposal();
    const runId = await createRunWithState(bom, proposal, true);

    let reviewerCalls = 0;
    let estimatorCalls = 0;

    const deps = makeDeps({
      reviewer: async () => {
        reviewerCalls += 1;
        const issue: Issue = {
          type: "missing_item",
          severity: "error",
          target_agent: "estimator",
          description: "missing patch cord",
          evidence_chunk_id: "00000000-0000-0000-0000-000000000000",
        };
        return {
          run_id: runId,
          round: reviewerCalls,
          decision: "revise",
          issues: [issue],
        };
      },
      estimator: async () => {
        estimatorCalls += 1;
        return {
          bom,
          verdicts: [],
          totals: {
            materials: "340.00",
            labor: "0.00",
            tax: "28.05",
            total: "368.05",
            includes_assumptions: false,
          },
          evidence_rounds: 0,
        };
      },
      writer: async () => proposal,
    });

    const state = await reviewAndRegenerate(runId, deps);

    expect(state.iterations).toBeLessThanOrEqual(2);
    expect(state.status).toBe("needs_review");
    expect(reviewerCalls).toBe(3);
    expect(estimatorCalls).toBe(2);

    const client = await pool.connect();
    try {
      const critiqueResult = await client.query("SELECT COUNT(*) AS c FROM critique WHERE run_id = $1", [runId]);
      expect(Number(critiqueResult.rows[0].c)).toBe(3);
    } finally {
      client.release();
    }
  });
});
