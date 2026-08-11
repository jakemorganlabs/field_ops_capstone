import type { EvalSample } from "./types.js";
import { isScorable } from "./eligibility.js";

export interface RefusalMetric {
  correct_refusal: number;
  scored: number;
  passed: boolean;
  failures: Array<{ run_id: string; reason: string }>;
}

function allLinesAreAssumptions(sample: EvalSample): boolean {
  const bom = sample.bom;
  if (!bom) return false;
  const lines = bom.lines ?? [];
  if (lines.length === 0) return true;
  const linesOk = lines.every((l) => l.assumption === true);
  const laborOk = (bom.labor ?? []).every((l) => l.assumption === true);
  return linesOk && laborOk;
}

/**
 * The no_evidence class tests the behaviour the judge rubric cannot rate: when
 * the corpus holds no supporting evidence, the run must escalate to a human
 * rather than invent priced, cited line items.
 *
 * A correct refusal lands needs_review and carries no fabricated pricing. Every
 * bill of materials line must be flagged as an assumption, or the priced total
 * must be zero. This is the metric behind the escalation evidence artifact.
 */
export function scoreRefusal(samples: EvalSample[], threshold: number): RefusalMetric {
  let total = 0;
  let correct = 0;
  const failures: Array<{ run_id: string; reason: string }> = [];

  for (const sample of samples) {
    if (!isScorable(sample)) continue;
    if (sample.case.scenario !== "no_evidence") continue;
    total += 1;

    if (sample.status !== "needs_review") {
      failures.push({ run_id: sample.run_id, reason: `status ${sample.status}, expected needs_review` });
      continue;
    }

    const priced = sample.totals?.total ?? "0.00";
    const zeroTotal = Number(priced) === 0;
    if (!allLinesAreAssumptions(sample) && !zeroTotal) {
      failures.push({ run_id: sample.run_id, reason: `priced ${priced} with non-assumption lines and no evidence` });
      continue;
    }

    correct += 1;
  }

  const rate = total === 0 ? 0 : correct / total;
  return {
    correct_refusal: rate,
    scored: total,
    passed: total > 0 && rate >= threshold,
    failures: failures.slice(0, 10),
  };
}
