import type { Pool } from "pg";
import { embedBatch, type EmbedCfg } from "./ingest/embedder.js";
import type { ProjectSpec } from "./qualification.js";

export type Intent = "similar_projects" | "manufacturer_specs" | "code_references";

export interface Retrieved {
  chunk_id: string;
  source: string;
  page: number | null;
  text: string;
  score: number;
}

export interface IntentResult {
  intent: Intent;
  query: string;
  chunks: Retrieved[];
  no_evidence: boolean;
}

export interface RetrievalCfg {
  pool: Pool;
  embedCfg: EmbedCfg;
  floors: Record<Intent, number>;
  maxChunks: number;
}

/**
 * Convert cosine distance to cosine similarity.
 * Similarity = 1 - distance.
 */
export function distanceToSimilarity(distance: number): number {
  return 1 - distance;
}

export async function retrieveIntent(
  intent: Intent,
  query: string,
  filters: { doc_type?: string; region?: string },
  cfg: RetrievalCfg
): Promise<IntentResult> {
  const embedResult = await embedBatch([query], cfg.embedCfg);
  const vector = embedResult.vectors[0];

  const conditions: string[] = [];
  const params: (string | number | null)[] = [];
  params.push(JSON.stringify(vector));

  if (filters.doc_type !== undefined) {
    params.push(filters.doc_type);
    conditions.push(`doc_type = $${params.length}`);
  }
  if (filters.region !== undefined) {
    params.push(filters.region);
    conditions.push(`region = $${params.length}`);
  }

  params.push(Math.max(1, cfg.maxChunks));
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT id, source, page, text, embedding <=> $1::vector AS distance
    FROM chunk
    ${whereClause}
    ORDER BY embedding <=> $1::vector
    LIMIT $${params.length}
  `;

  const client = await cfg.pool.connect();
  try {
    const result = await client.query(sql, params);
    const floor = cfg.floors[intent];
    const chunks: Retrieved[] = [];

    for (const row of result.rows) {
      const similarity = distanceToSimilarity(Number(row.distance));
      if (similarity >= floor) {
        chunks.push({
          chunk_id: row.id,
          source: row.source,
          page: row.page,
          text: row.text,
          score: similarity,
        });
      }
    }

    return {
      intent,
      query,
      chunks,
      no_evidence: chunks.length === 0,
    };
  } finally {
    client.release();
  }
}

export interface IntentQueries {
  similar_projects: string;
  manufacturer_specs: string;
  code_references: string;
}

/**
 * Build one query string per intent from fixed templates over the spec fields.
 * Do not call a model.
 */
export function buildIntentQueries(spec: ProjectSpec): IntentQueries {
  const project = spec.project_name ?? "";
  const scope = spec.scope ?? "";
  const location = spec.location ?? "";
  const region = spec.region ?? "";
  const materials = (spec.materials ?? []).join(" ");
  const constraints = (spec.constraints ?? []).join(" ");

  const queries: IntentQueries = {
    similar_projects: `${scope} ${region}`.trim() || "similar project",
    manufacturer_specs: materials || `${scope} material specifications`,
    code_references: `${constraints} ${region} code`.trim() || "code references",
  };

  console.log(JSON.stringify({ event: "intent_queries", queries }));
  return queries;
}
