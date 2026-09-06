import { describe, it, expect } from "vitest";
import { scoreStructural } from "../evals/metrics/structural.js";
import type { EvalSample } from "../evals/metrics/types.js";

const CHUNK = "11111111-1111-4111-8111-111111111111";
const RUN = "22222222-2222-4222-8222-222222222222";

function sample(): EvalSample {
  const bom = {
    run_id: RUN,
    lines: [{ item: "Cat6A keystone jack", quantity: "40", unit_cost: "8.50", citation: { chunk_id: CHUNK, snippet: "keystone jack: $8.50 each" } }],
    labor: [
      { role: "electrician", hours: "60", rate_key: "electrician", citation: { chunk_id: CHUNK, snippet: "electrician: $75.00 per hour" } },
      { role: "plumber", hours: "8", rate_key: "plumber", assumption: true, note: 'no configured labor rate for "plumber"' },
    ],
  };
  // 340.00 materials + 4500.00 labor (plumber contributes 0) = 4840.00; tax 0.0825 = 399.30; total 5239.30
  return {
    case: { intake: {}, scenario: "answerable", expected_route: "proceed" },
    run_id: RUN,
    status: "completed",
    route: "proceed",
    spec: { project_name: "Tower A", scope: "Install 40 jacks", location: "Denver", materials: ["keystone jack"], labor: ["electrician"], confidence: 0.9 } as EvalSample["spec"],
    bom,
    proposal: { run_id: RUN, bom_id: RUN, summary: "Install the jacks.", assumptions: ['plumber: no configured labor rate for "plumber"'], code_claims: [] },
    totals: { materials: "340.00", labor: "4500.00", tax: "399.30", total: "5239.30", includes_assumptions: true },
    retrieved: {},
    critique: null,
    errors: [],
  };
}

describe("structural calculator_balance", () => {
  it("balances a BOM whose assumption labor line has no configured rate, matching the shared calculator", async () => {
    const metrics = await scoreStructural([sample()]);
    expect(metrics.scored).toBe(1);
    expect(metrics.calculator_balance).toBe(1);
    expect(metrics.grounding_integrity).toBe(1);
  });

  it("fails balance when the persisted total disagrees with the calculator", async () => {
    const s = sample();
    s.totals = { ...s.totals!, total: "5000.00" };
    const metrics = await scoreStructural([s]);
    expect(metrics.calculator_balance).toBe(0);
  });
});
