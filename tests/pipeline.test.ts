import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import pg from "pg";
import { runPipeline } from "../src/pipeline.js";
import { generateJson } from "../src/llm.js";

vi.mock("../src/llm.js", () => ({
  generateJson: vi.fn(),
  SchemaFailure: class extends Error {},
}));

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

  it("proceeds for a complete intake", async () => {
    vi.mocked(generateJson).mockResolvedValueOnce({
      value: {
        project_name: "Tower A",
        scope: "Fiber install",
        location: "Denver",
        materials: ["fiber"],
        labor: ["tech"],
        confidence: 0.9,
      },
      tokens_in: 10,
      tokens_out: 10,
      latency_ms: 100,
      repaired: false,
    });

    const runId = await createPendingRun("hash1");
    await runPipeline(runId, { project_name: "Tower A" }, pool);

    const result = await pool.query("SELECT status, proposal FROM run WHERE id = $1", [runId]);
    expect(result.rows[0].status).toBe("running");
    expect(result.rows[0].proposal.route).toBe("proceed");

    const specResult = await pool.query("SELECT COUNT(*) AS c FROM spec");
    expect(Number(specResult.rows[0].c)).toBe(1);

    const auditResult = await pool.query("SELECT COUNT(*) AS c FROM audit");
    expect(Number(auditResult.rows[0].c)).toBe(1);
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
