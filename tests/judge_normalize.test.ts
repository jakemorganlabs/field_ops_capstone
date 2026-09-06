import { describe, it, expect } from "vitest";
import { ajv, normalizeModelPayload } from "../src/llm.js";

const schema = {
  type: "object",
  additionalProperties: true,
  required: ["scope_completeness", "hallucination", "assumptions_surfaced", "pricing_narrated", "concise_without_missing_required_content"],
  properties: {
    scope_completeness: { type: "number", minimum: 1, maximum: 5 },
    hallucination: { type: "number", minimum: 1, maximum: 5 },
    assumptions_surfaced: { type: "number", minimum: 1, maximum: 5 },
    pricing_narrated: { type: "number", minimum: 1, maximum: 5 },
    concise_without_missing_required_content: { type: "number", minimum: 1, maximum: 5 },
    excerpt: { type: "string" },
  },
};
const validate = ajv.compile({ type: "object", required: ["scores"], properties: { scores: schema } });

function scores(parsed: unknown): Record<string, unknown> {
  const out = normalizeModelPayload(parsed, "scores", schema) as Record<string, unknown>;
  expect(validate(out), JSON.stringify(validate.errors)).toBe(true);
  return out.scores as Record<string, unknown>;
}

describe("normalizeModelPayload (raw Gemma outputs captured 2026-09-06)", () => {
  it("strips the stray token glued to the first key and pulls a stray excerpt inside", () => {
    const raw = JSON.parse(
      '{"scores": {")}scope_completeness": 5, "hallucination": 2, "assumptions_surfaced": 1, "pricing_narrated": 5, "concise_without_missing_required_content": 5}, "excerpt": "labor_total: 3160.00"}'
    );
    const s = scores(raw);
    expect(s.scope_completeness).toBe(5);
    expect(s.excerpt).toBe("labor_total: 3160.00");
  });

  it("finds the scores when the wrapper key was replaced by a junk key", () => {
    const raw = JSON.parse(
      '{")} { ": "scores", "scope_completeness": 5, "hallucination": 2, "assumptions_surfaced": 1, "pricing_narrated": 4, "concise_without_missing_required_content": 5, "excerpt": "labor_total: 3160.00"}'
    );
    const s = scores(raw);
    expect(s.pricing_narrated).toBe(4);
    expect(s.excerpt).toBe("labor_total: 3160.00");
  });

  it("finds a nested value object and renames supporting_excerpt", () => {
    const raw = JSON.parse(
      '{")} { ": "scores", "value": {")} { ": "scope_completeness", "value": 5, "hallucination": 2, "assumptions_surfaced": 1, "pricing_narrated": 4, "concise_without_missing_required_content": 5, "supporting_excerpt": "labor_total: 3160.00"}}'
    );
    // The first key/value pair was mangled beyond repair ("scope_completeness" became a value), so the
    // required field is absent and this shape must still fail validation rather than be invented.
    const out = normalizeModelPayload(raw, "scores", schema) as Record<string, unknown>;
    expect(validate(out)).toBe(false);
  });

  it("coerces numeric strings and leaves a clean payload alone", () => {
    const raw = { scores: { scope_completeness: "5", hallucination: 2, assumptions_surfaced: 1, pricing_narrated: 4, concise_without_missing_required_content: 5, excerpt: "ok" } };
    const s = scores(raw);
    expect(s.scope_completeness).toBe(5);
    const clean = { scores: { scope_completeness: 5, hallucination: 2, assumptions_surfaced: 1, pricing_narrated: 4, concise_without_missing_required_content: 5, excerpt: "ok" } };
    expect(normalizeModelPayload(clean, "scores", schema)).toEqual(clean);
  });

  it("never invents a missing score", () => {
    const raw = { scores: { scope_completeness: 5, hallucination: 2 } };
    const out = normalizeModelPayload(raw, "scores", schema) as Record<string, unknown>;
    expect(validate(out)).toBe(false);
  });
});

describe("normalizeModelPayload on the generation path", () => {
  const prose = { type: "object", additionalProperties: false, required: ["summary"], properties: { summary: { type: "string" }, terms: { type: "string" } } };
  const validateProse = ajv.compile({ type: "object", required: ["prose"], properties: { prose } });

  it("repairs a slash-prefixed wrapper key", () => {
    const out = normalizeModelPayload({ "/prose": { summary: "Install the drops.", terms: "Net 30." } }, "prose", prose) as Record<string, unknown>;
    expect(validateProse(out)).toBe(true);
    expect((out.prose as Record<string, unknown>).summary).toBe("Install the drops.");
  });

  it("leaves an empty object invalid", () => {
    expect(validateProse(normalizeModelPayload({}, "prose", prose))).toBe(false);
  });

  it("does not touch a oneOf response schema with no top-level required fields", () => {
    const response = { type: "object", oneOf: [{ required: ["bom"] }, { required: ["evidence_request"] }] };
    const raw = { response: { bom: { run_id: "r", lines: [] } } };
    expect(normalizeModelPayload(raw, "response", response)).toEqual(raw);
  });
});
