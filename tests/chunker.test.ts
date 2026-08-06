import { describe, it, expect } from "vitest";
import { chunkDocument } from "../src/chunker.js";

describe("chunkDocument", () => {
  it("is deterministic for the same input", () => {
    const input = {
      text: "word ".repeat(2000),
      doc_type: "spec",
      source: "test",
      region: "US",
      date: "2026-08-05",
    };
    const a = chunkDocument(input);
    const b = chunkDocument(input);
    expect(a).toEqual(b);
  });

  it("attaches metadata to each chunk", () => {
    const chunks = chunkDocument({
      text: "word ".repeat(2000),
      doc_type: "spec",
      source: "test",
      region: "US",
      date: "2026-08-05",
    });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.doc_type).toBe("spec");
      expect(chunk.source).toBe("test");
      expect(chunk.region).toBe("US");
      expect(chunk.date).toBe("2026-08-05");
    }
  });

  it("returns empty array for empty text", () => {
    expect(chunkDocument({ text: "", doc_type: "spec", source: "test" })).toEqual([]);
  });
});
