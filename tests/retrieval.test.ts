import { describe, it, expect, vi } from "vitest";
import { distanceToSimilarity, retrieveIntent } from "../src/retrieval.js";
import * as embedder from "../src/ingest/embedder.js";

vi.mock("../src/ingest/embedder.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ingest/embedder.js")>();
  return {
    ...actual,
    embedBatch: vi.fn(),
  };
});

describe("distanceToSimilarity", () => {
  it("converts cosine distance to similarity", () => {
    expect(distanceToSimilarity(0)).toBe(1);
    expect(distanceToSimilarity(0.3)).toBe(0.7);
    expect(distanceToSimilarity(1)).toBe(0);
  });
});

describe("retrieveIntent no_evidence", () => {
  it("fires when all chunks are below the floor", async () => {
    const queryVector = new Array(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0));
    vi.mocked(embedder.embedBatch).mockResolvedValue({
      vectors: [queryVector],
      model_id: "test-model",
      dim: 1536,
    });

    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          id: "chunk-1",
          source: "test",
          page: null,
          text: "test text",
          distance: 0.6,
        },
      ],
    });

    const mockPool = {
      connect: vi.fn().mockResolvedValue({
        query,
        release: vi.fn(),
      }),
    };

    const result = await retrieveIntent(
      "similar_projects",
      "test query",
      {},
      {
        pool: mockPool as unknown as Parameters<typeof retrieveIntent>[3]["pool"],
        embedCfg: {
          baseUrl: "http://test",
          modelId: "test-model",
          dimensions: 1536,
          apiKey: "test",
        },
        floors: { similar_projects: 0.99, manufacturer_specs: 0.99, code_references: 0.99 },
        maxChunks: 5,
      }
    );

    expect(result.no_evidence).toBe(true);
    expect(result.chunks).toHaveLength(0);
  });
});
