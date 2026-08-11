import type { EvalSample } from "./types.js";
import { isScorable } from "./eligibility.js";

export interface EscalationMetric {
  route_accuracy: number;
  scored: number;
  passed: boolean;
  misroutes: Array<{ run_id: string; scenario: string; expected: string; actual: string }>;
}

/**
 * Route accuracy is the guard for every scoped metric in this harness. The
 * structural, retrieval, and semantic scorers narrow their denominators to the
 * proceed path, so a regression that misroutes cases has to fail here. The
 * previous version hardcoded passed: true and the gate never read it.
 */
export function scoreEscalation(samples: EvalSample[], threshold: number): EscalationMetric {
  let total = 0;
  let correct = 0;
  const misroutes: Array<{ run_id: string; scenario: string; expected: string; actual: string }> = [];

  for (const sample of samples) {
    if (!isScorable(sample)) continue;
    total += 1;
    if (sample.route === sample.case.expected_route) {
      correct += 1;
    } else {
      misroutes.push({
        run_id: sample.run_id,
        scenario: sample.case.scenario,
        expected: sample.case.expected_route,
        actual: sample.route,
      });
    }
  }

  const accuracy = total === 0 ? 0 : correct / total;
  return {
    route_accuracy: accuracy,
    scored: total,
    passed: total > 0 && accuracy >= threshold,
    misroutes: misroutes.slice(0, 10),
  };
}
