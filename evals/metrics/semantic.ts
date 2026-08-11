import { judgeJson } from "../../src/llm.js";
import { mapWithConcurrency } from "../concurrency.js";
import type { EvalSample } from "./types.js";
import { expectsPricedProposal } from "./eligibility.js";

export interface JudgeScores {
  scope_completeness: number;
  hallucination: number;
  assumptions_surfaced: number;
  pricing_narrated: number;
  concise_without_missing_required_content: number;
  excerpt: string;
}

export interface SemanticMetric {
  dimension: string;
  average: number;
  variance: number;
  high_variance_cases: number;
  scored: number;
  passed: boolean;
}

const judgeSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "scope_completeness",
    "hallucination",
    "assumptions_surfaced",
    "pricing_narrated",
    "concise_without_missing_required_content",
    "excerpt",
  ],
  properties: {
    scope_completeness: { type: "number", minimum: 1, maximum: 5 },
    hallucination: { type: "number", minimum: 1, maximum: 5 },
    assumptions_surfaced: { type: "number", minimum: 1, maximum: 5 },
    pricing_narrated: { type: "number", minimum: 1, maximum: 5 },
    concise_without_missing_required_content: { type: "number", minimum: 1, maximum: 5 },
    excerpt: { type: "string" },
  },
};

function buildJudgePrompt(sample: EvalSample): string {
  return `You are evaluating a construction proposal generated from a project spec and retrieved evidence.

Rate the proposal on these five dimensions, each from 1 to 5:
- scope_completeness: does the proposal cover the stated scope?
- hallucination: are there invented facts or unsupported claims?
- assumptions_surfaced: are assumptions clearly listed?
- pricing_narrated: are totals and line items described accurately?
- concise_without_missing_required_content: is the prose concise without omitting required content?

Return a JSON object with wrapper key "scores". Include a quoted excerpt that supports your ratings.

Project spec: ${JSON.stringify(sample.case.intake, null, 2)}

Proposal: ${JSON.stringify(sample.proposal, null, 2)}`;
}

export async function scoreSemantic(samples: EvalSample[], threshold: number): Promise<{ metrics: SemanticMetric[]; perSample: JudgeScores[][] }> {
  const dimensions = [
    "scope_completeness",
    "hallucination",
    "assumptions_surfaced",
    "pricing_narrated",
    "concise_without_missing_required_content",
  ];
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? 8);
  // The judge rates priced proposals. Cases that correctly refuse for lack of
  // evidence are excluded here and measured by scoreRefusal, because the
  // rubric dimensions scope_completeness and pricing_narrated would punish the
  // refusal this system is built to make.
  const perSample: JudgeScores[][] = await mapWithConcurrency(samples, concurrency, async (sample) => {
    if (!expectsPricedProposal(sample)) {
      return [];
    }
    const runs: JudgeScores[] = [];
    for (let i = 0; i < 3; i += 1) {
      try {
        const result = await judgeJson<JudgeScores>({
          system: "You are a strict evaluator of construction proposals. Return only the requested JSON.",
          user: buildJudgePrompt(sample),
          wrapperKey: "scores",
          schema: judgeSchema,
          maxTokens: 1024,
        });
        runs.push(result.value);
      } catch (err) {
        console.error(JSON.stringify({ event: "judge_error", run_id: sample.run_id, error: err instanceof Error ? err.message : String(err) }));
      }
    }
    return runs;
  });

  const metrics: SemanticMetric[] = [];
  for (const dimension of dimensions) {
    let sum = 0;
    let count = 0;
    let highVariance = 0;
    for (const runs of perSample) {
      if (runs.length === 0) continue;
      const values = runs.map((r) => (r as unknown as Record<string, number>)[dimension]);
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((sq, v) => sq + (v - avg) ** 2, 0) / values.length;
      sum += avg;
      count += 1;
      if (variance > 1.0) {
        highVariance += 1;
      }
    }
    const average = count === 0 ? 0 : sum / count;
    metrics.push({
      dimension,
      average,
      variance: 0,
      high_variance_cases: highVariance,
      scored: count,
      passed: count > 0 && average >= threshold,
    });
  }

  return { metrics, perSample };
}
