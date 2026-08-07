import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { chunkDocument } from "../chunker.js";
import type { ChunkInput } from "../chunker.js";
import type { ObjectStore } from "../objectstore.js";
import { embedBatch } from "./embedder.js";
import type { EmbedCfg } from "./embedder.js";
import { loadDocument } from "./loader.js";
import type { LoadedDocument } from "./loader.js";

export interface IngestOptions {
  runId?: string;
  docType: string;
  source: string;
  region?: string;
  date?: string;
  pool: Pool;
  store: ObjectStore;
  embedCfg: EmbedCfg;
  objectStorePrefix?: string;
}

export interface IngestResult {
  document_id?: string;
  filename: string;
  status: "ingested" | "already_ingested" | "failed";
  object_key?: string;
  content_hash?: string;
  chunks_upserted?: number;
  error?: string;
}

async function findDocumentByHash(
  client: PoolClient,
  contentHash: string
): Promise<{ id: string } | null> {
  const result = await client.query(
    "SELECT id FROM document WHERE content_hash = $1 LIMIT 1",
    [contentHash]
  );
  if (result.rowCount && result.rowCount > 0) {
    return { id: result.rows[0].id };
  }
  return null;
}

async function writeDeadLetter(
  client: PoolClient,
  runId: string | undefined,
  filename: string,
  error: string
): Promise<void> {
  const payload = {
    filename,
    phase: "ingest",
  };
  await client.query(
    `INSERT INTO dead_letter (run_id, payload, error, last_error)
     VALUES ($1, $2, $3, $3)`,
    [runId ?? null, JSON.stringify(payload), error]
  );
}

function objectKeyFor(prefix: string, docId: string, hash: string, ext: string): string {
  const safeExt = ext.replace(/^\./, "");
  return `${prefix}/${docId}_${hash}.${safeExt}`;
}

async function upsertDocument(
  client: PoolClient,
  documentId: string,
  doc: LoadedDocument,
  opts: IngestOptions,
  objectKey: string
): Promise<string> {
  const existing = await client.query(
    "SELECT id FROM document WHERE content_hash = $1 LIMIT 1",
    [doc.content_hash]
  );
  if (existing.rowCount && existing.rowCount > 0) {
    return existing.rows[0].id;
  }

  const rawText = doc.pages.map((p) => p.text).join("\n");
  const externalId = doc.filename;
  await client.query(
    `INSERT INTO document (
      id, external_id, source, doc_type, region, date,
      object_key, content_hash, raw_text, metadata
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      documentId,
      externalId,
      opts.source,
      opts.docType,
      opts.region ?? null,
      opts.date ?? null,
      objectKey,
      doc.content_hash,
      rawText,
      JSON.stringify({ filename: doc.filename }),
    ]
  );
  return documentId;
}

async function upsertChunks(
  client: PoolClient,
  documentId: string,
  chunks: ChunkInput[],
  embedResult: { vectors: number[][]; model_id: string },
  opts: IngestOptions,
  objectKey: string,
  contentHash: string
): Promise<number> {
  let upserted = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const vector = embedResult.vectors[i];
    const result = await client.query(
      `INSERT INTO chunk (
        document_id, content_hash, chunk_index, embed_model, embedding,
        text, doc_type, source, region, date, page, section, object_key, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (content_hash, chunk_index, embed_model) DO NOTHING
      RETURNING id`,
      [
        documentId,
        contentHash,
        chunk.chunk_index,
        embedResult.model_id,
        JSON.stringify(vector),
        chunk.text,
        chunk.doc_type,
        chunk.source,
        chunk.region ?? null,
        chunk.date ?? null,
        chunk.page ?? null,
        chunk.section ?? null,
        objectKey,
        JSON.stringify({}),
      ]
    );
    if (result.rowCount && result.rowCount > 0) {
      upserted += 1;
    }
  }
  return upserted;
}

export async function ingestDocument(
  path: string,
  opts: IngestOptions
): Promise<IngestResult> {
  const client = await opts.pool.connect();
  try {
    await client.query("BEGIN");

    const loaded = await loadDocument(path);
    const existing = await findDocumentByHash(client, loaded.content_hash);
    if (existing) {
      await client.query("COMMIT");
      return {
        document_id: existing.id,
        filename: loaded.filename,
        status: "already_ingested",
        content_hash: loaded.content_hash,
      };
    }

    const documentId = randomUUID();
    const extMatch = loaded.filename.match(/\.([^.]+)$/);
    const ext = extMatch ? extMatch[0] : "";
    const objectKey = objectKeyFor(
      opts.objectStorePrefix ?? "corpus",
      documentId,
      loaded.content_hash,
      ext
    );

    await opts.store.put(objectKey, loaded.bytes, "application/octet-stream");

    const chunkInputs: ChunkInput[] = loaded.pages.map((page) => ({
      text: page.text,
      doc_type: opts.docType,
      source: opts.source,
      region: opts.region,
      date: opts.date,
      page: page.page,
      section: undefined,
      object_key: objectKey,
    }));

    const chunks = chunkInputs.flatMap((input) => chunkDocument(input));

    let embedResult: { vectors: number[][]; model_id: string; dim: number };
    if (chunks.length > 0) {
      const texts = chunks.map((c) => c.text);
      embedResult = await embedBatch(texts, opts.embedCfg);
    } else {
      embedResult = { vectors: [], model_id: opts.embedCfg.modelId, dim: opts.embedCfg.dimensions };
    }

    await upsertDocument(client, documentId, loaded, opts, objectKey);
    const chunksUpserted = await upsertChunks(
      client,
      documentId,
      chunks,
      embedResult,
      opts,
      objectKey,
      loaded.content_hash
    );

    await client.query("COMMIT");
    return {
      document_id: documentId,
      filename: loaded.filename,
      status: "ingested",
      object_key: objectKey,
      content_hash: loaded.content_hash,
      chunks_upserted: chunksUpserted,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    const error = err instanceof Error ? err.message : String(err);
    const client2 = await opts.pool.connect();
    try {
      await writeDeadLetter(client2, opts.runId, path, error);
    } finally {
      client2.release();
    }
    return {
      filename: path.split("/").pop() || path,
      status: "failed",
      error,
    };
  } finally {
    client.release();
  }
}

export async function ingestFiles(
  paths: string[],
  opts: IngestOptions
): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const path of paths) {
    results.push(await ingestDocument(path, opts));
  }
  return results;
}
