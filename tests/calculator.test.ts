import { describe, it, expect } from "vitest";
import {
  extendedCost,
  materialSubtotal,
  laborTotal,
  proposalTotal,
} from "../src/calculator.js";

describe("calculator", () => {
  it("extendedCost handles fractional quantities exactly", () => {
    expect(extendedCost("3", "1.99")).toBe("5.97");
    expect(extendedCost("0.3333333333", "1.99")).toBe("0.66");
  });

  it("materialSubtotal rounds to cents at the end", () => {
    const lines = [
      { item: "conduit", quantity: "3", unit_cost: "1.99" },
      { item: "wire", quantity: "1", unit_cost: "10.00" },
    ];
    expect(materialSubtotal(lines)).toBe("15.97");
  });

  it("laborTotal uses rate map", () => {
    const labor = [{ role: "electrician", hours: "10", rate_key: "elec" }];
    expect(laborTotal(labor, { elec: "75.00" })).toBe("750.00");
  });

  it("proposalTotal applies tax exactly", () => {
    expect(proposalTotal("100.00", "50.00", "0.0825")).toBe("162.38");
  });
});
