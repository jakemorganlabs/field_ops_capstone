import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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

describe("qualify borderline rules", () => {
  const borderline: QualificationRules = {
    ...rules,
    vague_scope_terms: ["some", "several", "a few"],
    code_constraint_patterns: ["\\bNEC\\b", "\\bNFPA\\b"],
  };
  const complete: ProjectSpec = {
    project_name: "Lighting Retrofit",
    scope: "Replace 120 fluorescent troffers with LED panels",
    location: "Seattle",
    region: "WA",
    materials: ["LED troffer"],
    labor: ["electrician"],
    constraints: ["Title 24 compliance"],
  };

  it("proceeds for a complete, sized intake", () => {
    expect(qualify(complete, borderline).action).toBe("proceed");
  });

  it("clarifies when the scope uses an indefinite quantity", () => {
    const result = qualify({ ...complete, scope: "Replace some fluorescent troffers with LED panels" }, borderline);
    expect(result.action).toBe("clarify");
    expect(result.missing_fields).toContain("scope_quantity");
    expect(result.reasons.join(" ")).toMatch(/indefinite quantity \("some"\)/);
  });

  it("matches vague terms on word boundaries only", () => {
    expect(qualify({ ...complete, scope: "Install handsome fixtures, 40 total" }, borderline).action).toBe("proceed");
  });

  it("clarifies when a code-referenced constraint has no region", () => {
    const result = qualify({ ...complete, region: undefined, constraints: ["NEC Article 625", "ADA accessible"] }, borderline);
    expect(result.action).toBe("clarify");
    expect(result.missing_fields).toContain("region");
    expect(result.reasons.join(" ")).toMatch(/references a code; a region is required/);
  });

  it("proceeds without a region when no constraint references a code", () => {
    expect(qualify({ ...complete, region: undefined, constraints: ["vacuum rated"] }, borderline).action).toBe("proceed");
  });

  it("does not apply either rule when the config omits them", () => {
    expect(qualify({ ...complete, scope: "Replace some troffers", region: undefined, constraints: ["NEC 625"] }, rules).action).toBe("proceed");
  });
});

describe("qualify against the eval fixtures with the shipped rules", () => {
  // Deterministic route pass over fixtures/eval_cases with config/qualification_rules.json,
  // using the fixture confidence in place of the extraction model. Three near-miss cases
  // expect clarify but are complete on every field the rules can see; they are listed so a
  // change that fixes them, or breaks anything else, shows up here.
  const undecidable = new Set(["Office Cat6A Retrofit", "Fire Alarm Upgrade", "HVAC Controls Upgrade"]);

  it("routes every fixture the field rules can decide", () => {
    const shipped = JSON.parse(readFileSync("config/qualification_rules.json", "utf-8")) as QualificationRules;
    const floor = (JSON.parse(readFileSync("config/extraction.json", "utf-8")) as { conf_floor: number }).conf_floor;
    const misses: string[] = [];
    let total = 0;
    for (const file of ["answerable", "near_miss", "no_evidence", "adversarial"]) {
      const cases = JSON.parse(readFileSync(`fixtures/eval_cases/${file}.json`, "utf-8")) as Array<{
        intake: ProjectSpec & { confidence?: number };
        scenario: string;
        expected_route: string;
      }>;
      for (const c of cases) {
        total += 1;
        const conf = Number(c.intake.confidence);
        const action = !Number.isFinite(conf) || conf < floor ? "clarify" : qualify(c.intake, shipped).action;
        if (action !== c.expected_route) misses.push(`${c.scenario}:${c.intake.project_name}`);
      }
    }
    expect(total).toBe(50);
    expect(misses.sort()).toEqual(
      ["near_miss:Fire Alarm Upgrade", "near_miss:HVAC Controls Upgrade", "near_miss:Office Cat6A Retrofit"].filter((m) =>
        undecidable.has(m.split(":")[1])
      )
    );
  });
});
