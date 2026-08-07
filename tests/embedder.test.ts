import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { embedBatch } from "../src/ingest/embedder.js";

const cfg = {
  baseUrl: "https://api.test/embed",
  modelId: "test-model",
  dimensions: 4,
  apiKey: "test-key",
};

function makeVector(n: number): number[] {
  return Array(cfg.dimensions)
    .fill(0)
    .map((_, i) => n + i);
}

describe("embedder", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns vectors for a batch", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [
            { embedding: makeVector(1) },
            { embedding: makeVector(2) },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const result = await embedBatch(["hello", "world"], cfg);
    expect(result.vectors.length).toBe(2);
    expect(result.model_id).toBe("test-model");
    expect(result.dim).toBe(4);
    expect(result.vectors[0].length).toBe(4);
  });

  it("retries on 429 and succeeds", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate limited", { status: 429 });
      }
      return new Response(
        JSON.stringify({ data: [{ embedding: makeVector(1) }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const result = await embedBatch(["one"], cfg);
    expect(result.vectors.length).toBe(1);
    expect(calls).toBe(2);
  });

  it("throws on 401 without retry", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(embedBatch(["one"], cfg)).rejects.toThrow("terminal");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("throws when dimension mismatch is detected", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    await expect(embedBatch(["one"], cfg)).rejects.toThrow("dimension mismatch");
  });
});
