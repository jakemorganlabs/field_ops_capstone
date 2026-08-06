import { describe, it, expect } from "vitest";
import { normalizeSnippet } from "../src/normalize.js";

describe("normalizeSnippet", () => {
  it("applies NFC normalization", () => {
    expect(normalizeSnippet("\u00e9")).toBe("\u00e9");
    expect(normalizeSnippet("e\u0301")).toBe("\u00e9");
  });

  it("collapses whitespace", () => {
    expect(normalizeSnippet("hello   world\t\n")).toBe("hello world");
  });

  it("folds smart quotes to ASCII", () => {
    expect(normalizeSnippet("\u201chello\u201d")).toBe('"hello"');
    expect(normalizeSnippet("\u2018hello\u2019")).toBe("'hello'");
  });

  it("removes zero-width characters and NBSP", () => {
    expect(normalizeSnippet("hello\u200b\u200c\u200d\uFEFF\u00A0world")).toBe("hello world");
  });

  it("trims", () => {
    expect(normalizeSnippet("  spaced  ")).toBe("spaced");
  });
});
