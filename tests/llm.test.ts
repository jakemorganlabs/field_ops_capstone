import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import pg from "pg";
import { gemmaJson } from "../src/llm.js";

const databaseUrl = process.env.DATABASE_URL;

describe("llm audit", { tags: ["db"] }, () => {
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
      await client.query("TRUNCATE audit RESTART IDENTITY CASCADE");
    } finally {
      client.release();
    }
  });

  it("writes tokens_in and tokens_out to audit on a successful call", async () => {
    vi.stubEnv("DEEPINFRA_API_KEY", "dummy-key");
    vi.stubEnv("GENERATION_MODEL_ID", "dummy-model");

    const runId = "00000000-0000-0000-0000-000000000001";

    const setupClient = await pool.connect();
    try {
      await setupClient.query(
        "INSERT INTO run (id, intake_hash, status) VALUES ($1, $2, 'pending')",
        [runId, "test-hash"]
      );
    } finally {
      setupClient.release();
    }

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string" } },
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ result: { answer: "ok" } }) } }],
          usage: { prompt_tokens: 42, completion_tokens: 7 },
        }),
      })
    );

    await gemmaJson({
      system: "system",
      user: "user",
      wrapperKey: "result",
      schema,
      maxTokens: 100,
      audit: { run_id: runId, stage: "test" },
    });

    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT tokens_in, tokens_out FROM audit WHERE run_id = $1 AND action = 'test_tokens'",
        [runId]
      );
      expect(result.rowCount).toBe(1);
      expect(result.rows[0].tokens_in).toBe(42);
      expect(result.rows[0].tokens_out).toBe(7);
    } finally {
      client.release();
    }

    vi.unstubAllGlobals();
  });
});
