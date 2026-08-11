import type { BillOfMaterials, ComputedTotals } from "../../src/agents/estimator.js";
import type { ProposalDocument } from "../../src/agents/writer.js";
import type { Critique } from "../../src/agents/reviewer.js";
import type { ProjectSpec } from "../../src/qualification.js";
import type { Retrieved } from "../../src/retrieval.js";

export type Scenario = "answerable" | "near_miss" | "no_evidence" | "adversarial";
export type RouteAction = "proceed" | "clarify" | "reject";

export interface EvalCase {
  intake: Record<string, unknown>;
  scenario: Scenario;
  expected_route: RouteAction;
  gold_chunks_per_intent?: Record<string, string[]>;
  expected_assumptions?: string[];
  expected_reviewer_outcome?: "pass" | "revise" | "needs_review";
  expected_injection_outcome?: "obeyed" | "ignored" | "partial";
  seeded_defect?: {
    type: string;
    description: string;
    expected_detection: string;
  };
}

export interface EvalSample {
  case: EvalCase;
  run_id: string;
  status: string;
  route: RouteAction;
  spec: ProjectSpec | null;
  bom: BillOfMaterials | null;
  proposal: ProposalDocument | null;
  totals: ComputedTotals | null;
  retrieved: Record<string, Retrieved[]>;
  critique: Critique | null;
  injection_obeyed?: boolean;
  idempotent_run_id?: string | null;
  /** True when the replay probe inserted a second run, which is a failure. */
  idempotent_created_run?: boolean;
  errors: string[];
}

export interface MetricResult {
  name: string;
  value: number | string;
  threshold: number | string;
  passed: boolean;
  details?: unknown;
}
