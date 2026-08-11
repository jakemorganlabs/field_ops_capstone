import type { EvalSample } from "./types.js";
import { producedArtifacts } from "./eligibility.js";

export interface ReviewerMetric {
  recall: number;
  scored: number;
  passed: boolean;
  misses: Array<{ run_id: string; expected: string; actual_decision: string; status: string }>;
}

/**
 * Reviewer recall reads sample.critique.decision. The critique table column is
 * named verdict, so runCase maps verdict onto decision when it hydrates. With
 * the raw row the field was always undefined and this metric silently scored
 * every case as a "pass" default.
 */
export function scoreReviewer(samples: EvalSample[], threshold: number): ReviewerMetric {
  let total = 0;
  let detected = 0;
  const misses: Array<{ run_id: string; expected: string; actual_decision: string; status: string }> = [];

  for (const sample of samples) {
    const expected = sample.case.expected_reviewer_outcome;
    if (!expected) continue;
    // Only runs that reached the writer had a reviewer pass at all. A case that
    // correctly routed to clarify never invoked the reviewer, so scoring it
    // here handed out credit from the `?? "pass"` default.
    if (!producedArtifacts(sample)) continue;
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
    } else {
      misses.push({ run_id: sample.run_id, expected, actual_decision: actual, status });
    }
  }

  const recall = total === 0 ? 0 : detected / total;
  return { recall, scored: total, passed: total > 0 && recall >= threshold, misses: misses.slice(0, 10) };
}
