import type { EvalSample } from "./types.js";

export function scoreReviewer(samples: EvalSample[], threshold: number): { recall: number; passed: boolean } {
  let total = 0;
  let detected = 0;

  for (const sample of samples) {
    const expected = sample.case.expected_reviewer_outcome;
    if (!expected) continue;
    total += 1;

    const actual = sample.critique?.decision ?? "pass";
    const status = sample.status;

    let matched = false;
    if (expected === "pass") {
      matched = actual === "pass" && status === "completed";
    } else if (expected === "revise") {
      matched = actual === "revise" || status === "needs_review";
    } else if (expected === "needs_review") {
      matched = status === "needs_review";
    }

    if (matched) {
      detected += 1;
    }
  }

  const recall = total === 0 ? 1 : detected / total;
  return { recall, passed: recall >= threshold };
}
