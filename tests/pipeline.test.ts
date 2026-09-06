import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import pg from "pg";
import { runPipeline } from "../src/pipeline.js";
import { generateJson } from "../src/llm.js";
import { embedBatch } from "../src/ingest/embedder.js";

vi.mock("../src/llm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm.js")>()),
  generateJson: vi.fn(),
}));

// The proceed path embeds one query per intent. The embedding endpoint is the
// only network call left once generateJson is mocked, so stub it with a fixed
// unit vector and seed one chunk with the same vector (cosine distance 0).
vi.mock("../src/ingest/embedder.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/ingest/embedder.js")>()),
  embedBatch: vi.fn(),
}));

const UNIT_VECTOR = new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0));
const EVIDENCE_TEXT =
  "Similar project in Denver: Cat6A keystone jack: $8.50 each. Labor electrician: $75.00 per hour.";

function llmResult<T>(value: T) {
  return { value, tokens_in: 10, tokens_out: 10, latency_ms: 100, repaired: false };
}

const databaseUrl = process.env.DATABASE_URL;

describe("pipeline", { tags: ["db"] }, () => {
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
      await client.query("TRUNCATE run, spec, audit, dead_letter RESTART IDENTITY CASCADE");
    } finally {
      client.release();
    }
  });

  async function createPendingRun(hash: string): Promise<string> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "INSERT INTO run (intake_hash, status) VALUES ($1, 'pending') RETURNING id",
        [hash]
      );
      return result.rows[0].id;
    } finally {
      client.release();
    }
  }

  async function seedEvidenceChunk(): Promise<string> {
    const client = await pool.connect();
    try {
      const doc = await client.query(
        `INSERT INTO document (external_id, source, doc_type, object_key, content_hash)
         VALUES ('pipeline-test-doc', 'pipeline-test', 'eval_document', 'pipeline-test/doc', 'pipeline-test-hash')
         RETURNING id`
      );
      const chunk = await client.query(
        `INSERT INTO chunk (document_id, content_hash, chunk_index, embed_model, embedding, text, doc_type, source)
         VALUES ($1, 'pipeline-test-hash', 0, 'test-model', $2::vector, $3, 'eval_document', 'pipeline-test')
         RETURNING id`,
        [doc.rows[0].id, JSON.stringify(UNIT_VECTOR), EVIDENCE_TEXT]
      );
      return chunk.rows[0].id as string;
    } finally {
      client.release();
    }
  }

  async function removeEvidenceChunk(): Promise<void> {
    await pool.query("DELETE FROM document WHERE external_id = 'pipeline-test-doc'");
  }

  it("proceeds for a complete intake and runs the chain to completed", async () => {
    // Mock sequence follows the D7 chain: extraction, estimator, writer, reviewer.
    // A fifth call would return undefined and fail the run, which is the point.
    vi.mocked(embedBatch).mockResolvedValue({ vectors: [UNIT_VECTOR], model_id: "test-model", dim: 1536 });

    await removeEvidenceChunk();
    const chunkId = await seedEvidenceChunk();
    const runId = await createPendingRun("hash1");

    try {
      vi.mocked(generateJson)
        .mockResolvedValueOnce(
          llmResult({
            project_name: "Tower A",
            client_name: "Acme",
            location: "Denver",
            region: "CO",
            scope: "Install 40 Cat6A keystone jacks",
            materials: ["Cat6A keystone jack"],
            labor: ["electrician"],
            constraints: [],
            confidence: 0.9,
          })
        )
        .mockResolvedValueOnce(
          llmResult({
            bom: {
              run_id: runId,
              lines: [
                {
                  item: "Cat6A keystone jack",
                  quantity: "40",
                  unit_cost: "8.50",
                  citation: { chunk_id: chunkId, snippet: "keystone jack: $8.50 each" },
                },
              ],
              labor: [
                {
                  role: "electrician",
                  hours: "60",
                  rate_key: "electrician",
                  citation: { chunk_id: chunkId, snippet: "electrician: $75.00 per hour" },
                },
              ],
            },
          })
        )
        .mockResolvedValueOnce(
          llmResult({
            summary: "Install the keystone jacks listed in the bill of materials with licensed electrician labor.",
            terms: "Payment is due on completion.",
          })
        )
        .mockResolvedValueOnce(llmResult({ decision: "pass", issues: [] }));

      await runPipeline(runId, { project_name: "Tower A" }, pool);

      const stages = vi.mocked(generateJson).mock.calls.map((call) => call[0].audit?.stage);
      expect(stages).toEqual(["extraction", "estimator", "writer", "reviewer"]);
      expect(vi.mocked(embedBatch)).toHaveBeenCalledTimes(3);

      const run = await pool.query(
        "SELECT status, proposal, bom, total_cost, retrieval_sets, critique FROM run WHERE id = $1",
        [runId]
      );
      const row = run.rows[0];
      expect(row.status).toBe("completed");
      expect(row.critique).toBeNull();

      // 40 x 8.50 = 340.00 materials; 60 h x 75.00 = 4500.00 labor;
      // tax 0.0825 on 4840.00 = 399.30; total 5239.30 (config/labor_rates.json, config/tax.json).
      expect(row.total_cost).toBe("5239.30");
      expect(row.proposal.summary).toBe(
        "Install the keystone jacks listed in the bill of materials with licensed electrician labor."
      );
      expect(row.proposal.material_subtotal).toBe("340.00");
      expect(row.proposal.labor_total).toBe("4500.00");
      expect(row.proposal.tax_amount).toBe("399.30");
      expect(row.proposal.total).toBe("5239.30");
      expect(row.proposal.line_items).toEqual([
        { description: "Cat6A keystone jack", amount: "340.00", quantity: "40", unit_price: "8.50" },
      ]);
      expect(row.proposal.assumptions).toEqual([]);
      expect(row.proposal.code_claims).toEqual([]);

      // Citations survived the grounding gate: nothing was recast as an assumption.
      expect(row.bom.lines[0].citation.chunk_id).toBe(chunkId);
      expect(row.bom.lines[0].assumption).toBeUndefined();
      expect(row.bom.labor[0].citation.chunk_id).toBe(chunkId);
      expect(row.retrieval_sets.similar_projects[0].chunk_id).toBe(chunkId);

      const specResult = await pool.query("SELECT COUNT(*) AS c FROM spec");
      expect(Number(specResult.rows[0].c)).toBe(1);

      const auditResult = await pool.query("SELECT action FROM audit WHERE run_id = $1 ORDER BY created_at", [runId]);
      expect(auditResult.rows.map((r) => r.action)).toEqual(["qualification", "estimate", "proposal"]);

      const critiqueResult = await pool.query("SELECT round, verdict, issues FROM critique WHERE run_id = $1", [runId]);
      expect(critiqueResult.rows).toEqual([{ round: 1, verdict: "pass", issues: [] }]);

      const deadLetter = await pool.query("SELECT COUNT(*) AS c FROM dead_letter");
      expect(Number(deadLetter.rows[0].c)).toBe(0);
    } finally {
      await removeEvidenceChunk();
    }
  });

  it("clarifies a vague intake", async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      value: {
        project_name: "Site work",
        scope: "Install something",
        confidence: 0.9,
      },
      tokens_in: 10,
      tokens_out: 10,
      latency_ms: 100,
      repaired: false,
    });

    const runId = await createPendingRun("hash2");
    await runPipeline(runId, { project_name: "Site work" }, pool);

    const result = await pool.query("SELECT status, proposal FROM run WHERE id = $1", [runId]);
    expect(result.rows[0].status).toBe("completed");
    expect(result.rows[0].proposal.route).toBe("clarify");
    expect(result.rows[0].proposal.missing_fields.length).toBeGreaterThan(0);
  });

  it("rejects an incomplete intake", async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      value: {
        project_name: "Home alarm",
        confidence: 0.9,
      },
      tokens_in: 10,
      tokens_out: 10,
      latency_ms: 100,
      repaired: false,
    });

    const runId = await createPendingRun("hash3");
    await runPipeline(runId, { project_name: "Home alarm" }, pool);

    const result = await pool.query("SELECT status, proposal FROM run WHERE id = $1", [runId]);
    expect(result.rows[0].status).toBe("rejected");
    expect(result.rows[0].proposal.route).toBe("reject");
  });

  it("clarifies when extraction confidence is below the floor", async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      value: {
        project_name: "Tower A",
        scope: "Fiber install",
        location: "Denver",
        materials: ["fiber"],
        labor: ["tech"],
        confidence: 0.1,
      },
      tokens_in: 10,
      tokens_out: 10,
      latency_ms: 100,
      repaired: false,
    });

    const runId = await createPendingRun("hash4");
    await runPipeline(runId, { project_name: "Tower A" }, pool);

    const result = await pool.query("SELECT status, proposal FROM run WHERE id = $1", [runId]);
    expect(result.rows[0].status).toBe("completed");
    expect(result.rows[0].proposal.route).toBe("clarify");
  });
});
