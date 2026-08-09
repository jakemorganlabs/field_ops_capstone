import type { EvalSample } from "./types.js";

export function scoreEscalation(samples: EvalSample[]): { route_accuracy: number; passed: boolean } {
  let total = 0;
  let correct = 0;

  for (const sample of samples) {
    if (sample.errors.length > 0) continue;
    total += 1;
    if (sample.route === sample.case.expected_route) {
      correct += 1;
    }
  }

  const accuracy = total === 0 ? 1 : correct / total;
  return { route_accuracy: accuracy, passed: true };
}
