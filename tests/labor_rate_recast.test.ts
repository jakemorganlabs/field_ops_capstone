import { describe, it, expect } from "vitest";
import { recastUnknownLaborRates, type BillOfMaterials } from "../src/agents/estimator.js";
import { bomHasNoEvidence } from "../src/review_loop.js";

const CHUNK = "11111111-1111-4111-8111-111111111111";

describe("recastUnknownLaborRates", () => {
  it("turns labor lines with unknown rate keys into noted assumptions and leaves known ones alone", () => {
    const bom: BillOfMaterials = {
      lines: [],
      labor: [
        { role: "electrician", hours: "10", rate_key: "electrician", citation: { chunk_id: CHUNK, snippet: "electrician: $75.00" } },
        { role: "plumber", hours: "6", rate_key: "plumber", citation: { chunk_id: CHUNK, snippet: "plumber" } },
        { role: "subsea engineer", hours: "40", rate_key: "subsea engineer" },
      ],
    };
    const recast = recastUnknownLaborRates(bom, { electrician: "75.00" });
    expect(recast).toEqual(["plumber", "subsea engineer"]);
    expect(bom.labor?.[0].assumption).toBeUndefined();
    expect(bom.labor?.[0].citation?.chunk_id).toBe(CHUNK);
    expect(bom.labor?.[1]).toMatchObject({ assumption: true, citation: undefined, note: 'no configured labor rate for "plumber"' });
    expect(bom.labor?.[2]).toMatchObject({ assumption: true, note: 'no configured labor rate for "subsea engineer"' });
  });

  it("is a no-op when every rate key is configured", () => {
    const bom: BillOfMaterials = { lines: [], labor: [{ role: "electrician", hours: "1", rate_key: "electrician", assumption: true }] };
    expect(recastUnknownLaborRates(bom, { electrician: "75.00" })).toEqual([]);
  });
});

describe("bomHasNoEvidence", () => {
  it("is true when every material and labor line is an assumption", () => {
    expect(
      bomHasNoEvidence({
        lines: [{ item: "a", quantity: "1", unit_cost: "0.00", assumption: true }],
        labor: [{ role: "r", hours: "1", rate_key: "x", assumption: true }],
      })
    ).toBe(true);
  });

  it("is true for an empty bill of materials", () => {
    expect(bomHasNoEvidence({ lines: [] })).toBe(true);
  });

  it("is false when at least one line carries a citation", () => {
    expect(
      bomHasNoEvidence({
        lines: [
          { item: "a", quantity: "1", unit_cost: "0.00", assumption: true },
          { item: "b", quantity: "1", unit_cost: "8.50", citation: { chunk_id: CHUNK, snippet: "b: $8.50" } },
        ],
      })
    ).toBe(false);
  });
});
