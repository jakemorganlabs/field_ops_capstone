import type { EvalSample } from "./types.js";

export function scoreIngest(samples: EvalSample[]): { exact: number; passed: boolean } {
  let total = 0;
  let exact = 0;

  for (const sample of samples) {
    if (sample.idempotent_run_id === undefined) continue;
    total += 1;
    if (sample.idempotent_run_id === sample.run_id) {
      exact += 1;
    }
  }

  const rate = total === 0 ? 1 : exact / total;
  return { exact: rate, passed: rate === 1 };
}
