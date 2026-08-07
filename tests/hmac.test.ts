import { describe, it, expect } from "vitest";
import { signRequest, verifyRequest } from "../src/hmac.js";

describe("hmac", () => {
  const secret = "test-secret";

  it("signs and verifies a request", () => {
    const signed = signRequest({ secret, method: "POST", path: "/intake", body: '{"a":1}' });
    const verified = verifyRequest({
      secret,
      method: "POST",
      path: "/intake",
      body: '{"a":1}',
      authorization: signed.header,
      now: signed.ts,
    });
    expect(verified.ok).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signed = signRequest({ secret, method: "POST", path: "/intake", body: '{"a":1}' });
    const verified = verifyRequest({
      secret,
      method: "POST",
      path: "/intake",
      body: '{"a":2}',
      authorization: signed.header,
      now: signed.ts,
    });
    expect(verified.ok).toBe(false);
  });

  it("rejects an expired timestamp", () => {
    const signed = signRequest({ secret, method: "POST", path: "/intake", body: '{"a":1}', ts: 1000 });
    const verified = verifyRequest({
      secret,
      method: "POST",
      path: "/intake",
      body: '{"a":1}',
      authorization: signed.header,
      now: 1000 + 301,
    });
    expect(verified.ok).toBe(false);
  });

  it("rejects a missing authorization header", () => {
    const verified = verifyRequest({
      secret,
      method: "POST",
      path: "/intake",
      body: '{"a":1}',
      authorization: "",
    });
    expect(verified.ok).toBe(false);
  });
});
