import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { fsObjectStore } from "../src/objectstore.js";
import { ingestDocument } from "../src/ingest/ingest.js";

vi.mock("../src/ingest/embedder.js", () => {
  return {
    embedBatch: vi.fn(async (texts: string[]) => {
      return {
        vectors: texts.map((_, i) =>
          Array(1536)
            .fill(0)
            .map((_, j) => i + j / 1536)
        ),
        model_id: "test-embed-model",
        dim: 1536,
      };
    }),
  };
});

const databaseUrl = process.env.DATABASE_URL;

describe("ingest", { tags: ["db"] }, () => {
  if (!databaseUrl) {
    it.skip("DATABASE_URL not set", () => {});
    return;
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  let objectRoot: string;
  let store: ReturnType<typeof fsObjectStore>;

  beforeEach(async () => {
    objectRoot = await mkdtemp(join(tmpdir(), "fieldops-ingest-"));
    store = fsObjectStore(objectRoot);
    const client = await pool.connect();
    try {
      await client.query("TRUNCATE document, chunk, dead_letter RESTART IDENTITY CASCADE");
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool.end();
  });

  const embedCfg = {
    baseUrl: "https://api.test/embed",
    modelId: "test-embed-model",
    dimensions: 1536,
    apiKey: "test-key",
  };

  it("ingests a document and chunks", async () => {
    const file = join(objectRoot, "doc.md");
    await writeFile(file, "This is a synthetic document for testing.");

    const result = await ingestDocument(file, {
      docType: "proposal",
      source: "test",
      pool,
      store,
      embedCfg,
    });

    expect(result.status).toBe("ingested");
    expect(result.document_id).toBeDefined();
    expect(result.object_key).toBeDefined();

    const docResult = await pool.query("SELECT * FROM document WHERE id = $1", [
      result.document_id,
    ]);
    expect(docResult.rowCount).toBe(1);
    expect(docResult.rows[0].object_key).toBe(result.object_key);

    const chunkResult = await pool.query(
      "SELECT COUNT(*) AS c FROM chunk WHERE document_id = $1",
      [result.document_id]
    );
    expect(Number(chunkResult.rows[0].c)).toBeGreaterThan(0);

    const bytes = await store.get(result.object_key!);
    expect(bytes.toString()).toBe("This is a synthetic document for testing.");
  });

  it("marks a duplicate document as already_ingested", async () => {
    const file = join(objectRoot, "doc.md");
    await writeFile(file, "Duplicate content test.");

    const first = await ingestDocument(file, {
      docType: "proposal",
      source: "test",
      pool,
      store,
      embedCfg,
    });
    expect(first.status).toBe("ingested");

    const second = await ingestDocument(file, {
      docType: "proposal",
      source: "test",
      pool,
      store,
      embedCfg,
    });
    expect(second.status).toBe("already_ingested");
    expect(second.document_id).toBe(first.document_id);
  });

  it("writes a failure to dead_letter and continues", async () => {
    const badFile = join(objectRoot, "bad.unknown");
    await writeFile(badFile, "Bad content.");

    const result = await ingestDocument(badFile, {
      docType: "proposal",
      source: "test",
      pool,
      store,
      embedCfg,
    });

    expect(result.status).toBe("failed");
    const deadResult = await pool.query("SELECT COUNT(*) AS c FROM dead_letter");
    expect(Number(deadResult.rows[0].c)).toBe(1);
  });
});
