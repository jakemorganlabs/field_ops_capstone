import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateJson } from "../src/llm.js";
import { runReviewer, applyDecisionPrecedence, type Critique, type ReviewInput } from "../src/agents/reviewer.js";

vi.mock("../src/llm.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm.js")>()),
  generateJson: vi.fn(),
}));

const CHUNK = "11111111-1111-4111-8111-111111111111";

function input(): ReviewInput {
  const evidence = {
    intent: "similar_projects" as const,
    query: "q",
    chunks: [{ chunk_id: CHUNK, source: "spec.md", page: null, text: "keystone jack: $8.50 each", score: 0.9 }],
    no_evidence: false,
  };
  return {
    run_id: "22222222-2222-4222-8222-222222222222",
    round: 1,
    spec: { project_name: "Tower A", scope: "Install 40 keystone jacks", location: "Denver", materials: ["keystone jack"], labor: ["electrician"] },
    bom: {
      lines: [{ item: "keystone jack", quantity: "40", unit_cost: "8.50", citation: { chunk_id: CHUNK, snippet: "keystone jack: $8.50 each" } }],
      labor: [{ role: "electrician", hours: "60", rate_key: "electrician", assumption: true }],
    },
    totals: { materials: "340.00", labor: "4500.00", tax: "399.30", total: "5239.30", includes_assumptions: true },
    proposal: { run_id: "r", bom_id: "r", summary: "Install the jacks.", assumptions: ["electrician"], code_claims: [] },
    evidence: { similar_projects: evidence, manufacturer_specs: { ...evidence, intent: "manufacturer_specs" }, code_references: { ...evidence, intent: "code_references" } },
  };
}

function llm(value: unknown) {
  return { value, tokens_in: 1, tokens_out: 1, latency_ms: 1, repaired: false };
}

describe("reviewer decision precedence", () => {
  beforeEach(() => {
    vi.mocked(generateJson).mockReset();
  });

  it("downgrades a revise carried only by warnings and info to pass, keeping the issues", async () => {
    vi.mocked(generateJson).mockResolvedValueOnce(
      llm({
        decision: "revise",
        issues: [
          { type: "pricing_anomaly", severity: "warning", target_agent: "estimator", description: "Tax shown on a small subtotal." },
          { type: "missing_item", severity: "info", target_agent: "estimator", description: "Consider fasteners and sealant." },
        ],
      })
    );
    const critique = await runReviewer(input());
    expect(critique.decision).toBe("pass");
    expect(critique.issues).toHaveLength(2);
    expect(critique.comment).toMatch(/downgraded to pass/);
    expect(critique.run_id).toBe("22222222-2222-4222-8222-222222222222");
    expect(critique.round).toBe(1);
  });

  it("keeps a revise that names an error-severity defect", async () => {
    vi.mocked(generateJson).mockResolvedValueOnce(
      llm({
        decision: "revise",
        issues: [
          { type: "missing_item", severity: "error", target_agent: "estimator", description: "Spec names wall plates; BOM has no wall plate line.", evidence_chunk_id: CHUNK },
          { type: "scope_mismatch", severity: "info", target_agent: "writer", description: "Summary could be shorter." },
        ],
      })
    );
    const critique = await runReviewer(input());
    expect(critique.decision).toBe("revise");
    expect(critique.comment).toBeUndefined();
  });

  it("leaves a pass untouched", async () => {
    vi.mocked(generateJson).mockResolvedValueOnce(llm({ decision: "pass", issues: [] }));
    const critique = await runReviewer(input());
    expect(critique.decision).toBe("pass");
    expect(critique.issues).toEqual([]);
  });

  it("applyDecisionPrecedence is a pure rule over the critique", () => {
    const c: Critique = { run_id: "x", round: 2, decision: "revise", issues: [{ type: "regulatory_gap", severity: "warning", target_agent: "estimator", description: "No permit line.", evidence_chunk_id: "" }], comment: "Looks close." };
    expect(applyDecisionPrecedence(c).decision).toBe("pass");
    expect(c.comment).toBe("Looks close. Precedence: revise downgraded to pass; no error-severity defect against spec or evidence.");
  });
});
