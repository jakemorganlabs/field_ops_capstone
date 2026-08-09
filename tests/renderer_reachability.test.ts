import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function* walkTsFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(fullPath);
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      yield fullPath;
    }
  }
}

describe("renderer reachability", () => {
  it("only calls renderProposalPdf from src/gate.ts", async () => {
    const allowedPaths = ["src/gate.ts", "src/pdf.ts", "tests/renderer_reachability.test.ts"];
    const calls: string[] = [];
    for await (const path of walkTsFiles("src")) {
      const text = await readFile(path, "utf-8");
      if (text.includes("renderProposalPdf(")) {
        calls.push(path);
      }
    }
    const offenders = calls.filter((p) => !allowedPaths.some((allowed) => p.endsWith(allowed)));
    expect(offenders).toEqual([]);
  });
});
