import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

describe("db", () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    it.skip("DATABASE_URL not set", () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("migrations table exists and records applied files", async () => {
    const result = await pool.query("SELECT filename FROM migrations ORDER BY filename");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("inserts and queries vectors by cosine distance", async () => {
    const docResult = await pool.query(
      "INSERT INTO document (external_id, source, doc_type, object_key, content_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      ["db-test", "db-src", "doc", "db-obj", "db-hash"]
    );
    const docId = docResult.rows[0].id;

    const vector = Array(1536).fill(0);
    vector[0] = 1;
    await pool.query(
      "INSERT INTO chunk (document_id, content_hash, chunk_index, embed_model, embedding, text, doc_type, source) VALUES ($1, $2, $3, $4, $5::vector, $6, $7, $8)",
      [docId, "db-chunk", 0, "test-model", `[${vector.join(",")}]`, "db test chunk", "doc", "db-src"]
    );

    const result = await pool.query(
      "SELECT id, embedding <=> $1::vector AS distance FROM chunk ORDER BY embedding <=> $1::vector LIMIT 1",
      [`[${vector.join(",")}]`]
    );
    expect(result.rows.length).toBe(1);
    expect(Number(result.rows[0].distance)).toBe(0);

    await pool.query("DELETE FROM chunk WHERE document_id = $1", [docId]);
    await pool.query("DELETE FROM document WHERE id = $1", [docId]);
  });
});
