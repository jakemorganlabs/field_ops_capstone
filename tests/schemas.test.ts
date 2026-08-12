import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);

function loadSchema(name: string) {
  const path = join(__dirname, "..", "schemas", name);
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadJson(name: string) {
  const path = join(__dirname, "..", "fixtures", "eval_cases", name);
  return JSON.parse(readFileSync(path, "utf-8"));
}

describe("schemas", () => {
  it("project_spec accepts a valid example and rejects an extra property", () => {
    const validate = ajv.compile(loadSchema("project_spec.json"));
    expect(validate({ project_name: "Tower A", scope: "Fiber install", extra: true })).toBe(false);
    expect(validate({ project_name: "Tower A", scope: "Fiber install", confidence: 0.9 })).toBe(true);
  });

  it("bom accepts a valid example and rejects an extra property", () => {
    const validate = ajv.compile(loadSchema("bom.json"));
    expect(
      validate({
        run_id: "00000000-0000-0000-0000-000000000000",
        lines: [],
        extra: true,
      })
    ).toBe(false);
    expect(
      validate({
        run_id: "00000000-0000-0000-0000-000000000000",
        lines: [
          {
            item: "conduit",
            quantity: "10",
            unit_cost: "5.00",
            citation: { chunk_id: "00000000-0000-0000-0000-000000000000", snippet: "conduit" },
          },
        ],
      })
    ).toBe(true);
  });

  it("proposal accepts a valid example and rejects an extra property", () => {
    const validate = ajv.compile(loadSchema("proposal.json"));
    expect(
      validate({
        run_id: "00000000-0000-0000-0000-000000000000",
        bom_id: "00000000-0000-0000-0000-000000000000",
        summary: "Proposal",
        extra: true,
        assumptions: [],
        code_claims: [],
      })
    ).toBe(false);
    expect(
      validate({
        run_id: "00000000-0000-0000-0000-000000000000",
        bom_id: "00000000-0000-0000-0000-000000000000",
        summary: "Proposal",
        assumptions: [],
        code_claims: [],
      })
    ).toBe(true);
  });

  it("critique accepts a valid example and tolerates an extra top-level key", () => {
    const validate = ajv.compile(loadSchema("critique.json"));
    expect(
      validate({
        run_id: "00000000-0000-0000-0000-000000000000",
        decision: "pass",
        issues: [],
        extra: true,
      })
    ).toBe(true);
    expect(
      validate({
        run_id: "00000000-0000-0000-0000-000000000000",
        decision: "pass",
        issues: [
          {
            type: "missing_item",
            severity: "error",
            target_agent: "estimator",
            description: "missing patch cord",
            evidence_chunk_id: "00000000-0000-0000-0000-000000000000",
          },
        ],
      })
    ).toBe(true);
  });

  it("run accepts a valid example and rejects an extra property", () => {
    const validate = ajv.compile(loadSchema("run.json"));
    expect(
      validate({
        intake_hash: "abc",
        status: "pending",
        extra: true,
      })
    ).toBe(false);
    expect(
      validate({
        intake_hash: "abc",
        status: "pending",
      })
    ).toBe(true);
  });
});
