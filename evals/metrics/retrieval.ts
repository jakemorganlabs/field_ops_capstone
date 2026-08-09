import type { EvalSample } from "./types.js";

export interface RetrievalMetric {
  intent: string;
  recall: number;
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
  if (typeof chunk.source === "string" && chunk.source.length > 0) {
    return chunk.source;
  }
  return sourceFromChunkId(chunk.chunk_id ?? "");
}

export function scoreRetrieval(samples: EvalSample[], thresholds: Record<string, number>): RetrievalMetric[] {
  const intents = ["similar_projects", "manufacturer_specs", "code_references"];
  const metrics: RetrievalMetric[] = [];

  for (const intent of intents) {
    let total = 0;
    let passed = 0;
    for (const sample of samples) {
      const gold = sample.case.gold_chunks_per_intent?.[intent];
      if (!gold || gold.length === 0) continue;
      total += 1;
      const retrieved = sample.retrieved[intent] ?? [];
      const retrievedSources = new Set(retrieved.map((c) => sourceFromChunk(c)));
      const hits = gold.filter((g) => retrievedSources.has(g)).length;
      const recall = hits / gold.length;
      if (recall >= (thresholds[intent] ?? 0.8)) {
        passed += 1;
      }
    }
    const recall = total === 0 ? 1 : passed / total;
    metrics.push({ intent, recall, passed: recall >= (thresholds[intent] ?? 0.8) });
  }

  return metrics;
}
