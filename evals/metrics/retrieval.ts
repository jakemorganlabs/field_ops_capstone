import type { EvalSample } from "./types.js";
import { expectsProposal } from "./eligibility.js";

export interface RetrievalMetric {
  intent: string;
  recall: number;
  scored: number;
  eligible: number;
  passed: boolean;
}

function sourceFromChunkId(chunkId: string): string {
  const parts = chunkId.split("_");
  if (parts.length >= 2) {
    return parts.slice(0, parts.length - 1).join("_") + ".md";
  }
  return chunkId;
}

function sourceFromChunk(chunk: { source?: string; chunk_id?: string }): string {
  const raw = typeof chunk.source === "string" && chunk.source.length > 0 ? chunk.source : sourceFromChunkId(chunk.chunk_id ?? "");
  // evals/seed.ts prefixes sources with "eval_"; strip it for scoring.
  return raw.replace(/^eval_/, "");
}

/**
 * Recall is scored only on cases the fixture expects to reach retrieval.
 * A case that correctly routes to clarify never calls retrieveIntent, so an
 * empty retrieval set there is correct behaviour rather than a recall miss.
 * eligible and scored are reported so a shrinking denominator is visible.
 */
export function scoreRetrieval(samples: EvalSample[], thresholds: Record<string, number>): RetrievalMetric[] {
  const intents = ["similar_projects", "manufacturer_specs", "code_references"];
  const metrics: RetrievalMetric[] = [];

  for (const intent of intents) {
    let eligible = 0;
    let scored = 0;
    let passedCases = 0;
    for (const sample of samples) {
      const gold = sample.case.gold_chunks_per_intent?.[intent];
      if (!gold || gold.length === 0) continue;
      eligible += 1;
      if (!expectsProposal(sample)) continue;
      scored += 1;
      const retrieved = sample.retrieved[intent] ?? [];
      const retrievedSources = new Set(retrieved.map((c) => sourceFromChunk(c)));
      const hits = gold.filter((g) => retrievedSources.has(g)).length;
      const recall = hits / gold.length;
      if (recall >= (thresholds[intent] ?? 0.8)) {
        passedCases += 1;
      }
    }
    const recall = scored === 0 ? 0 : passedCases / scored;
    metrics.push({
      intent,
      recall,
      scored,
      eligible,
      passed: scored > 0 && recall >= (thresholds[intent] ?? 0.8),
    });
  }

  return metrics;
}
