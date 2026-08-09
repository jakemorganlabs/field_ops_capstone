import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { fsObjectStore } from "../src/objectstore.js";
import { ingestFiles } from "../src/ingest/ingest.js";
import type { EmbedCfg } from "../src/ingest/embedder.js";

const OBJECT_STORE_DIR = process.env.OBJECT_STORE_DIR ?? "./eval_objects";
const EMBEDDING_BASE_URL = process.env.EMBEDDING_BASE_URL ?? "";
const EMBEDDING_MODEL_ID = process.env.EMBEDDING_MODEL_ID ?? "";
const EMBEDDING_DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
const DEEPINFRA_API_KEY = process.env.DEEPINFRA_API_KEY ?? "";

export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const files = (await readdir("migrations")).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = await readFile(join("migrations", file), "utf-8");
      await client.query(sql);
    }
  } finally {
    client.release();
  }
}

export async function cleanDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE audit, chunk, critique, dead_letter, document, feedback, human_edits, run, spec CASCADE");
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function seedCorpus(pool: pg.Pool): Promise<void> {
  const store = fsObjectStore(OBJECT_STORE_DIR);
  const embedCfg: EmbedCfg = {
    baseUrl: EMBEDDING_BASE_URL,
    modelId: EMBEDDING_MODEL_ID,
    dimensions: EMBEDDING_DIMENSIONS,
    apiKey: DEEPINFRA_API_KEY,
  };

  const files = (await readdir("fixtures/synthetic_corpus")).filter((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".pdf");
  });

  await ingestFiles(
    files.map((f) => join("fixtures/synthetic_corpus", f)),
    {
      docType: "eval_document",
      source: "eval_corpus",
      pool,
      store,
      embedCfg,
      objectStorePrefix: "eval_corpus",
    }
  );

  const client = await pool.connect();
  try {
    await client.query("UPDATE document SET source = 'eval_' || source");
    await client.query("UPDATE chunk SET source = 'eval_' || source");
  } finally {
    client.release();
  }
}
