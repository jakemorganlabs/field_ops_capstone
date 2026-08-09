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

  async function createRunWithState(bom: BillOfMaterials, proposal: ProposalDocument): Promise<string> {
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
            similar_projects: [],
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

  it("does not reach a third iteration", async () => {
    const bom = makeBom();
    const proposal = makeProposal();
    const runId = await createRunWithState(bom, proposal);

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
