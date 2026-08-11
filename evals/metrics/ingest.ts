import type { EvalSample } from "./types.js";

export interface IngestMetric {
  exact: number;
  scored: number;
  duplicates_created: number;
  passed: boolean;
}

/**
 * Idempotent re-submission: replaying an identical intake must resolve to the
 * original run and must not create a second run row.
 *
 * Only cases that ran the replay probe are scored. The previous version
 * skipped on `undefined` while runCase always returned `null` for the other
 * scenario classes, so every non-adversarial case was counted as a failure and
 * the metric could never reach 1.0.
 */
export function scoreIngest(samples: EvalSample[]): IngestMetric {
  let total = 0;
  let exact = 0;
  let duplicates = 0;

  for (const sample of samples) {
    if (sample.idempotent_run_id === undefined || sample.idempotent_run_id === null) continue;
    total += 1;
    if (sample.idempotent_run_id === sample.run_id) {
      exact += 1;
    }
    if (sample.idempotent_created_run === true) {
      duplicates += 1;
    }
  }

  const rate = total === 0 ? 0 : exact / total;
  return {
    exact: rate,
    scored: total,
    duplicates_created: duplicates,
    passed: total > 0 && rate === 1 && duplicates === 0,
  };
}
