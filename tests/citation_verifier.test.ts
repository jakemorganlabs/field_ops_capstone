import { describe, it, expect } from "vitest";
import { verifyBomCitations, type BomLine } from "../src/citation_verifier.js";

describe("verifyBomCitations", () => {
  const retrieved = new Set<string>(["chunk-1"]);
  const textById = new Map<string, string>([["chunk-1", "The conduit is 2 inches in diameter."]]);

  it("passes when chunk is retrieved and snippet is found", () => {
    const lines: BomLine[] = [
      {
        item: "conduit",
        quantity: "10",
        unit_cost: "5.00",
        citation: { chunk_id: "chunk-1", snippet: "conduit is 2 inches" },
      },
    ];
    const verdicts = verifyBomCitations(lines, retrieved, textById);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].verified).toBe(true);
    expect(verdicts[0].recast_assumption).toBe(false);
    expect(verdicts[0].reason).toBeNull();
  });

  it("fails when chunk is not in retrieved set", () => {
    const lines: BomLine[] = [
      {
        item: "conduit",
        quantity: "10",
        unit_cost: "5.00",
        citation: { chunk_id: "chunk-2", snippet: "conduit" },
      },
    ];
    const verdicts = verifyBomCitations(lines, retrieved, textById);
    expect(verdicts[0].verified).toBe(false);
    expect(verdicts[0].recast_assumption).toBe(true);
  });

  it("fails when snippet is not in chunk text", () => {
    const lines: BomLine[] = [
      {
        item: "conduit",
        quantity: "10",
        unit_cost: "5.00",
        citation: { chunk_id: "chunk-1", snippet: "nonexistent phrase" },
      },
    ];
    const verdicts = verifyBomCitations(lines, retrieved, textById);
    expect(verdicts[0].verified).toBe(false);
    expect(verdicts[0].recast_assumption).toBe(true);
    expect(verdicts[0].reason).toBe("Citation snippet not found in retrieved chunk text");
  });

  it("bypasses verification for assumptions", () => {
    const lines: BomLine[] = [
      {
        item: "conduit",
        quantity: "10",
        unit_cost: "5.00",
        assumption: true,
      },
    ];
    const verdicts = verifyBomCitations(lines, new Set(), new Map());
    expect(verdicts[0].verified).toBe(true);
    expect(verdicts[0].recast_assumption).toBe(false);
  });

  it("reports multiple failures", () => {
    const lines: BomLine[] = [
      {
        item: "conduit",
        quantity: "10",
        unit_cost: "5.00",
        citation: { chunk_id: "chunk-1", snippet: "conduit is 2 inches" },
      },
      {
        item: "wire",
        quantity: "100",
        unit_cost: "0.50",
        citation: { chunk_id: "chunk-2", snippet: "wire" },
      },
    ];
    const verdicts = verifyBomCitations(lines, retrieved, textById);
    expect(verdicts[0].verified).toBe(true);
    expect(verdicts[1].verified).toBe(false);
  });
});
