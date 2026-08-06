import { describe, it, expect } from "vitest";
import { intakeIdempotencyKey } from "../src/idempotency.js";

describe("intakeIdempotencyKey", () => {
  it("produces the same key for equivalent payloads", () => {
    const a = intakeIdempotencyKey({ name: " Project ", tags: ["A", "B"] });
    const b = intakeIdempotencyKey({ name: "  project  ", tags: ["a", "b"] });
    expect(a).toBe(b);
  });

  it("drops null optional fields", () => {
    const a = intakeIdempotencyKey({ name: "project", note: null });
    const b = intakeIdempotencyKey({ name: "project" });
    expect(a).toBe(b);
  });

  it("sorts object keys", () => {
    const a = intakeIdempotencyKey({ a: 1, b: 2 });
    const b = intakeIdempotencyKey({ b: 2, a: 1 });
    expect(a).toBe(b);
  });
});
