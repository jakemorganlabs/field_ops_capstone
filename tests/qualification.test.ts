import { describe, it, expect } from "vitest";
import { qualify, type ProjectSpec, type QualificationRules } from "../src/qualification.js";

const rules: QualificationRules = {
  required_fields: ["project_name", "scope", "location"],
  min_materials: 1,
  min_labor: 1,
  reject_threshold: 40,
  clarify_threshold: 80,
  field_weights: {
    project_name: 2,
    scope: 2,
    location: 1,
  },
};

describe("qualify", () => {
  it("proceeds when all required fields and counts are present", () => {
    const spec: ProjectSpec = {
      project_name: "Tower A",
      scope: "Install fiber",
      location: "Denver",
      materials: ["fiber"],
      labor: ["tech"],
    };
    const result = qualify(spec, rules);
    expect(result.action).toBe("proceed");
    expect(result.score).toBe(100);
    expect(result.missing_fields).toHaveLength(0);
  });

  it("rejects when far below threshold", () => {
    const spec: ProjectSpec = {};
    const result = qualify(spec, rules);
    expect(result.action).toBe("reject");
    expect(result.score).toBeLessThan(rules.reject_threshold);
  });

  it("clarifies at boundary", () => {
    const spec: ProjectSpec = {
      project_name: "Tower A",
      scope: "Install fiber",
      location: "",
      materials: [],
      labor: [],
    };
    const result = qualify(spec, rules);
    expect(result.action).toBe("clarify");
    expect(result.score).toBeGreaterThanOrEqual(rules.reject_threshold);
    expect(result.score).toBeLessThan(rules.clarify_threshold);
  });
});
