import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { fsObjectStore } from "../src/objectstore.js";
import { ingestFiles } from "../src/ingest/ingest.js";
import type { EmbedCfg } from "../src/ingest/embedder.js";

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
  // Read env at call time: this module loads before dotenv.config() runs in entry scripts.
  const store = fsObjectStore(process.env.OBJECT_STORE_DIR ?? "./eval_objects");
  const embedCfg: EmbedCfg = {
    baseUrl: process.env.EMBEDDING_BASE_URL ?? "",
    modelId: process.env.EMBEDDING_MODEL_ID ?? "",
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
    apiKey: process.env.DEEPINFRA_API_KEY ?? "",
  };
  if (embedCfg.baseUrl === "" || embedCfg.apiKey === "") {
    throw new Error("seedCorpus requires EMBEDDING_BASE_URL and DEEPINFRA_API_KEY");
  }

  const files = (await readdir("fixtures/synthetic_corpus")).filter((f) => {
    const lower = f.toLowerCase();
    return lower.endsWith(".md") || lower.endsWith(".txt") || lower.endsWith(".pdf");
  });

  // Ingest each file with its filename as the source so eval gold sources match.
  for (const file of files) {
    await ingestFiles(
      [join("fixtures/synthetic_corpus", file)],
      {
        docType: "eval_document",
        source: file,
        pool,
        store,
        embedCfg,
        objectStorePrefix: "eval_corpus",
      }
    );
  }
}
