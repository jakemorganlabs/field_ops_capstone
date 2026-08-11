import type { EvalSample } from "./types.js";

/**
 * Denominator rules for the metric scorers.
 *
 * Each metric scores only the cases that can express the behaviour it
 * measures. A case that correctly routes to clarify has no bill of materials
 * and no proposal, so counting it as a structural failure measures the fixture
 * design, not the system. Route correctness is measured on its own by
 * scoreEscalation, and artifact coverage is reported next to every scoped
 * metric so a scoped denominator can never hide a regression.
 */

/** The case ran to completion without a harness or pipeline error. */
export function isScorable(sample: EvalSample): boolean {
  return sample.errors.length === 0;
}

/** The fixture expects this case to reach the estimator and writer. */
export function expectsProposal(sample: EvalSample): boolean {
  return isScorable(sample) && sample.case.expected_route === "proceed";
}

/** The case expected a proposal and actually produced the artifacts. */
export function producedArtifacts(sample: EvalSample): boolean {
  return expectsProposal(sample) && sample.bom !== null && sample.proposal !== null;
}

/**
 * The case expects a priced proposal that the judge rubric can rate.
 * The no_evidence class is excluded on purpose: a correct refusal declines to
 * narrate pricing and declines to claim full scope, so the judge dimensions
 * scope_completeness and pricing_narrated would penalise the exact behaviour
 * the class is testing. Those cases are measured by scoreRefusal instead.
 */
export function expectsPricedProposal(sample: EvalSample): boolean {
  return producedArtifacts(sample) && sample.case.scenario !== "no_evidence";
}

/** Fraction of cases that were expected to produce artifacts and did. */
export function coverage(samples: EvalSample[]): { scored: number; eligible: number; coverage: number } {
  const eligible = samples.filter(expectsProposal).length;
  const scored = samples.filter(producedArtifacts).length;
  return { scored, eligible, coverage: eligible === 0 ? 1 : scored / eligible };
}
