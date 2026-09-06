import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluateGate, type ResultsFile, type Thresholds } from "../evals/gate.js";
import { badgeState } from "../evals/badge.js";

const thresholds = JSON.parse(readFileSync("evals/thresholds.json", "utf-8")) as Thresholds;

const passingRetrieval = [
  { intent: "similar_projects", recall: 1, scored: 1, eligible: 1, passed: true },
  { intent: "manufacturer_specs", recall: 1, scored: 1, eligible: 1, passed: true },
  { intent: "code_references", recall: 1, scored: 1, eligible: 1, passed: true },
];

function smokeResults(overrides: Partial<ResultsFile> = {}): ResultsFile {
  return {
    mode: "smoke",
    commit_hash: "test",
    timestamp: "2026-01-01T00:00:00.000Z",
    counts: { answerable: 1, near_miss: 0, no_evidence: 0, adversarial: 0 },
    retrieval: passingRetrieval,
    samples: [],
    ...overrides,
  };
}

function fullResults(overrides: Partial<ResultsFile> = {}): ResultsFile {
  return {
    commit_hash: "test",
    timestamp: "2026-01-01T00:00:00.000Z",
    counts: { answerable: 1, near_miss: 0, no_evidence: 0, adversarial: 0 },
    retrieval: passingRetrieval,
    structural: { schema_validity: 1, calculator_balance: 1, grounding_integrity: 1, scored: 1, eligible: 1, coverage: 1 },
    semantic: [{ dimension: "prose_clear", average: 4, variance: 0, high_variance_cases: 0, scored: 1, passed: true }],
    reviewer: { recall: 1, scored: 1, passed: true },
    escalation: { route_accuracy: 1, scored: 1, passed: true },
    injection: { obeyed: 0, passed: true },
    ingest: { exact: 1, scored: 1, duplicates_created: 0, passed: true },
    refusal: { correct_refusal: 1, scored: 1, passed: true },
    samples: [],
    ...overrides,
  };
}

describe("eval gate", () => {
  it("passes a smoke run on retrieval alone and names every unmeasured section", () => {
    const outcome = evaluateGate(smokeResults(), thresholds);
    expect(outcome.mode).toBe("smoke");
    expect(outcome.failures).toEqual([]);
    expect(outcome.unmeasured).toEqual(["structural", "semantic", "reviewer", "escalation", "injection", "ingest", "refusal"]);
  });

  it("fails a smoke run whose retrieval misses the floor", () => {
    const outcome = evaluateGate(
      smokeResults({ retrieval: [{ intent: "code_references", recall: 0.5, scored: 1, eligible: 1, passed: false }] }),
      thresholds
    );
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]).toMatch(/code_references: 0.50 < 0.8/);
  });

  it("does not let a full run pass with sections missing", () => {
    const { structural, semantic, ...rest } = fullResults();
    void structural;
    void semantic;
    const outcome = evaluateGate(rest as ResultsFile, thresholds);
    expect(outcome.mode).toBe("full");
    expect(outcome.failures).toContain("structural: section missing from results file");
    expect(outcome.failures).toContain("semantic: section missing from results file");
  });

  it("passes a complete full run that clears every threshold", () => {
    const outcome = evaluateGate(fullResults(), thresholds);
    expect(outcome.failures).toEqual([]);
    expect(outcome.unmeasured).toEqual([]);
  });

  it("fails a full run below reviewer recall", () => {
    const outcome = evaluateGate(fullResults({ reviewer: { recall: 0.37, scored: 15, passed: false } }), thresholds);
    expect(outcome.failures.some((f) => f.startsWith("reviewer_recall: 0.37"))).toBe(true);
  });
});

describe("eval badge", () => {
  it("labels a smoke run as smoke and reports retrieval only", () => {
    expect(badgeState(smokeResults())).toEqual({ label: "smoke", value: "retrieval ok", passed: true });
  });

  it("does not call a full run passing when a section is absent", () => {
    const { reviewer, ...rest } = fullResults();
    void reviewer;
    expect(badgeState(rest as ResultsFile).passed).toBe(false);
  });

  it("calls a complete passing full run passing", () => {
    expect(badgeState(fullResults())).toEqual({ label: "evals", value: "passing", passed: true });
  });
});
