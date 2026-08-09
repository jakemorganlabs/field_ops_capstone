import { describe, it, expect, vi, beforeEach } from "vitest";
import { runEstimator, type Deps, type BillOfMaterials } from "../src/agents/estimator.js";
import { generateJson } from "../src/llm.js";
import { retrieveIntent } from "../src/retrieval.js";
import type { Intent, IntentResult } from "../src/retrieval.js";
import type { ProjectSpec } from "../src/qualification.js";

vi.mock("../src/llm.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/llm.js")>();
  return {
    ...actual,
    generateJson: vi.fn(),
    SchemaFailure: class extends Error {},
  };
});

vi.mock("../src/retrieval.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/retrieval.js")>();
  return {
    ...actual,
    retrieveIntent: vi.fn(),
  };
});

function createMockPool(): { query: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  const connect = vi.fn().mockResolvedValue({
    query,
    release: vi.fn(),
  });
  return { query, connect };
}

function createEvidence(): Record<Intent, IntentResult> {
  return {
    similar_projects: {
      intent: "similar_projects",
      query: "test",
      chunks: [],
      no_evidence: true,
    },
    manufacturer_specs: {
      intent: "manufacturer_specs",
      query: "test",
      chunks: [
        {
          chunk_id: "chunk-1",
          source: "synthetic",
          page: null,
          text: "The cable costs $100.00 per drop.",
          score: 0.95,
        },
      ],
      no_evidence: false,
    },
    code_references: {
      intent: "code_references",
      query: "test",
      chunks: [],
      no_evidence: true,
    },
  };
}

describe("runEstimator evidence loop", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("cannot pass 2 evidence rounds", async () => {
    const spec: ProjectSpec = {
      project_name: "Test",
      scope: "Install drops",
      location: "CA",
      confidence: 0.9,
    };

    const evidence = createEvidence();
    const mockPool = createMockPool();

    const deps: Deps = {
      pool: mockPool as unknown as Deps["pool"],
      retrievalCfg: {
        pool: mockPool as unknown as Deps["pool"],
        embedCfg: {
          baseUrl: "http://test",
          modelId: "test",
          dimensions: 4,
          apiKey: "test",
        },
        floors: {
          similar_projects: 0.7,
          manufacturer_specs: 0.65,
          code_references: 0.7,
        },
        maxChunks: 5,
      },
      rateMap: { electrician: "75.00" },
      taxRate: "0.0825",
      runId: "run-1",
    };

    const requestedBom: BillOfMaterials = {
      run_id: "run-1",
      lines: [
        {
          item: "cable",
          quantity: "1",
          unit_cost: "100.00",
          citation: { chunk_id: "chunk-1", snippet: "cable costs $100.00" },
        },
      ],
    };

    vi.mocked(generateJson)
      .mockResolvedValueOnce({
        value: {
          evidence_request: {
            intent: "manufacturer_specs" as Intent,
            query: "cable price",
            reason: "need price",
          },
        },
        tokens_in: 10,
        tokens_out: 5,
        latency_ms: 100,
        repaired: false,
      })
      .mockResolvedValueOnce({
        value: {
          evidence_request: {
            intent: "manufacturer_specs" as Intent,
            query: "connector price",
            reason: "need connector price",
          },
        },
        tokens_in: 10,
        tokens_out: 5,
        latency_ms: 100,
        repaired: false,
      })
      .mockResolvedValueOnce({
        value: { bom: requestedBom },
        tokens_in: 10,
        tokens_out: 5,
        latency_ms: 100,
        repaired: false,
      });

    vi.mocked(retrieveIntent).mockResolvedValue({
      intent: "manufacturer_specs",
      query: "cable price",
      chunks: [
        {
          chunk_id: "chunk-2",
          source: "synthetic",
          page: null,
          text: "Connector costs $5.00 each.",
          score: 0.9,
        },
      ],
      no_evidence: false,
    });

    const outcome = await runEstimator(spec, evidence, deps);

    expect(outcome.evidence_rounds).toBe(2);
    expect(outcome.bom.lines).toHaveLength(1);
    expect(vi.mocked(retrieveIntent)).toHaveBeenCalledTimes(2);
  });
});
