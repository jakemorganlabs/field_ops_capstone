import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { Decimal } from "decimal.js";
import { runEstimator, type BillOfMaterials, type ComputedTotals, type EstimatorOutcome } from "./agents/estimator.js";
import { runReviewer, type Critique, type Issue, type IssueType } from "./agents/reviewer.js";
import { runWriter, type ProposalDocument } from "./agents/writer.js";
import { materialSubtotal, laborTotal, proposalTotal } from "./calculator.js";
import { verifyBomCitations, verifyLaborCitations } from "./citation_verifier.js";
import { findNumericalDrift, type DriftFinding } from "./drift_validator.js";
import { findMissingAssumptions, type MissingAssumption } from "./assumption_check.js";
import { runCodeClaimGate } from "./code_claim_gate.js";
import type { ProjectSpec } from "./qualification.js";
import type { Intent, IntentResult, Retrieved, RetrievalCfg } from "./retrieval.js";

export const ROUTING: Record<IssueType, ("estimator" | "writer")[]> = {
  missing_item: ["estimator"],
  pricing_anomaly: ["estimator"],
  regulatory_gap: ["estimator"],
  scope_mismatch: ["writer"],
};

export interface LoopState {
  iterations: number;
  open_issues: Issue[];
  status: "reviewing" | "passed" | "needs_review";
}

export interface Deps {
  pool: Pool;
  retrievalCfg: RetrievalCfg;
  rateMap: Record<string, string>;
  taxRate: string;
  reviewer?: (input: {
    run_id: string;
    round: number;
    spec: ProjectSpec;
    bom: BillOfMaterials;
    totals: ComputedTotals;
    proposal: ProposalDocument;
    evidence: Record<Intent, IntentResult>;
  }) => Promise<Critique>;
  estimator?: (
    spec: ProjectSpec,
    evidence: Record<Intent, IntentResult>,
    deps: { pool: Pool; retrievalCfg: RetrievalCfg; rateMap: Record<string, string>; taxRate: string; runId: string },
    issues: string[]
  ) => Promise<EstimatorOutcome>;
  writer?: (
    bom: BillOfMaterials,
    totals: ComputedTotals,
    templates: IntentResult,
    deps: { pool: Pool; runId: string; taxRate: string },
    issues: string[]
  ) => Promise<ProposalDocument>;
}

interface RunState {
  spec_id: string;
  bom: BillOfMaterials | null;
  proposal: ProposalDocument | null;
  retrieval_sets: Record<string, { chunk_id: string; score: number }[]> | null;
}

interface LoadedState {
  spec: ProjectSpec;
  bom: BillOfMaterials;
  proposal: ProposalDocument;
  evidence: Record<Intent, IntentResult>;
  chunks: Map<string, Retrieved>;
}

async function loadRunState(client: PoolClient, runId: string): Promise<RunState> {
  const result = await client.query(
    "SELECT spec_id, bom, proposal, retrieval_sets FROM run WHERE id = $1 LIMIT 1",
    [runId]
  );
  if (!result.rowCount || result.rowCount === 0) {
    throw new Error(`run ${runId} not found`);
  }
  const row = result.rows[0];
  return {
    spec_id: row.spec_id,
    bom: row.bom,
    proposal: row.proposal,
    retrieval_sets: row.retrieval_sets,
  };
}

async function loadSpec(client: PoolClient, specId: string): Promise<ProjectSpec> {
  const result = await client.query("SELECT * FROM spec WHERE id = $1 LIMIT 1", [specId]);
  if (!result.rowCount || result.rowCount === 0) {
    throw new Error(`spec ${specId} not found`);
  }
  const row = result.rows[0];
  return {
    project_name: row.project_name,
    client_name: row.client_name,
    location: row.location,
    region: row.region,
    start_date: row.start_date,
    end_date: row.end_date,
    scope: row.scope,
    materials: Array.isArray(row.materials) ? row.materials : JSON.parse(row.materials ?? "[]"),
    labor: Array.isArray(row.labor) ? row.labor : JSON.parse(row.labor ?? "[]"),
    constraints: Array.isArray(row.constraints) ? row.constraints : JSON.parse(row.constraints ?? "[]"),
    notes: row.notes,
    raw_text: row.raw_text,
  };
}

async function fetchChunks(
  client: PoolClient,
  retrievalSets: Record<string, { chunk_id: string; score: number }[]>
): Promise<Map<string, Retrieved>> {
  const map = new Map<string, Retrieved>();
  const ids = new Set<string>();
  for (const intent of Object.keys(retrievalSets)) {
    for (const entry of retrievalSets[intent]) {
      ids.add(entry.chunk_id);
    }
  }
  if (ids.size === 0) return map;

  const result = await client.query("SELECT id, source, page, text FROM chunk WHERE id = ANY($1)", [
    Array.from(ids),
  ]);
  for (const row of result.rows) {
    map.set(row.id, {
      chunk_id: row.id,
      source: row.source,
      page: row.page,
      text: row.text,
      score: 0,
    });
  }
  return map;
}

function buildEvidence(
  retrievalSets: Record<string, { chunk_id: string; score: number }[]>,
  chunks: Map<string, Retrieved>
): Record<Intent, IntentResult> {
  const evidence = {} as Record<Intent, IntentResult>;
  for (const intent of ["similar_projects", "manufacturer_specs", "code_references"] as Intent[]) {
    const entries = retrievalSets[intent] ?? [];
    const intentChunks: Retrieved[] = [];
    for (const entry of entries) {
      const chunk = chunks.get(entry.chunk_id);
      if (chunk) {
        intentChunks.push({ ...chunk, score: entry.score });
      }
    }
    evidence[intent] = {
      intent,
      query: intent,
      chunks: intentChunks,
      no_evidence: intentChunks.length === 0,
    };
  }
  return evidence;
}

function computeTotals(bom: BillOfMaterials, rateMap: Record<string, string>, taxRate: string): ComputedTotals {
  const materials = materialSubtotal(bom.lines);
  const labor = bom.labor ? laborTotal(bom.labor, rateMap) : "0.00";
  const total = proposalTotal(materials, labor, taxRate);
  const base = new Decimal(materials).plus(new Decimal(labor));
  const tax = base.mul(new Decimal(taxRate)).toDecimalPlaces(2).toFixed(2);
  const includesAssumptions =
    bom.lines.some((l) => l.assumption === true) || (bom.labor?.some((l) => l.assumption === true) ?? false);
  return { materials, labor, tax, total, includes_assumptions: includesAssumptions };
}

async function loadState(deps: Deps, runId: string): Promise<LoadedState> {
  const client = await deps.pool.connect();
  try {
    const runState = await loadRunState(client, runId);
    if (!runState.spec_id) throw new Error(`run ${runId} has no spec_id`);
    if (!runState.bom) throw new Error(`run ${runId} has no bom`);
    if (!runState.proposal) throw new Error(`run ${runId} has no proposal`);

    const spec = await loadSpec(client, runState.spec_id);
    const chunks = await fetchChunks(client, runState.retrieval_sets ?? {});
    const evidence = buildEvidence(runState.retrieval_sets ?? {}, chunks);

    return { spec, bom: runState.bom, proposal: runState.proposal, evidence, chunks };
  } finally {
    client.release();
  }
}

async function persistCritique(client: PoolClient, critique: Critique): Promise<void> {
  await client.query(
    `INSERT INTO critique (run_id, round, verdict, score, issues, corrected_bom, corrected_proposal)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      critique.run_id,
      critique.round ?? 0,
      critique.decision,
      null,
      JSON.stringify(critique.issues),
      null,
      null,
    ]
  );
}

async function persistRunStatus(client: PoolClient, runId: string, status: string, issues?: Issue[]): Promise<void> {
  await client.query("UPDATE run SET status = $1, critique = $2, updated_at = NOW() WHERE id = $3", [
    status,
    issues ? JSON.stringify({ issues }) : null,
    runId,
  ]);
}

async function appendAudit(
  client: PoolClient,
  runId: string,
  action: string,
  payload: unknown
): Promise<void> {
  await client.query(
    `INSERT INTO audit (run_id, table_name, record_id, action, new_value)
     VALUES ($1, 'run', $2, $3, $4)`,
    [runId, runId, action, JSON.stringify(payload)]
  );
}

function groupIssues(issues: Issue[]): { estimator: string[]; writer: string[] } {
  const estimator: string[] = [];
  const writer: string[] = [];
  for (const issue of issues) {
    const targets = ROUTING[issue.type];
    if (targets.includes("estimator")) {
      estimator.push(`${issue.type}: ${issue.description}`);
    }
    if (targets.includes("writer")) {
      writer.push(`${issue.type}: ${issue.description}`);
    }
  }
  return { estimator, writer };
}

function runGroundingGate(bom: BillOfMaterials, chunks: Map<string, Retrieved>): Issue[] {
  const findings: Issue[] = [];
  const retrievedIds = new Set<string>(chunks.keys());
  const textById = new Map<string, string>();
  for (const [id, chunk] of chunks) {
    textById.set(id, chunk.text);
  }

  const verdicts = verifyBomCitations(bom.lines, retrievedIds, textById);
  for (let i = 0; i < verdicts.length; i += 1) {
    const line = bom.lines[i];
    const verdict = verdicts[i];
    if (!verdict.verified && verdict.recast_assumption) {
      line.assumption = true;
      line.note = verdict.reason ?? line.note;
      line.citation = undefined;
    }
    if (!verdict.verified) {
      findings.push({
        type: "regulatory_gap",
        severity: "error",
        target_agent: "estimator",
        description: verdict.reason ?? `citation failed for ${line.item}`,
        evidence_chunk_id: line.citation?.chunk_id ?? "00000000-0000-0000-0000-000000000000",
      });
    }
  }

  if (bom.labor) {
    const laborVerdicts = verifyLaborCitations(bom.labor, retrievedIds, textById);
    for (let i = 0; i < laborVerdicts.length; i += 1) {
      const line = bom.labor[i];
      const verdict = laborVerdicts[i];
      if (!verdict.verified && verdict.recast_assumption) {
        line.assumption = true;
        line.citation = undefined;
      }
      if (!verdict.verified) {
        findings.push({
          type: "regulatory_gap",
          severity: "error",
          target_agent: "estimator",
          description: verdict.reason ?? `citation failed for ${line.role}`,
          evidence_chunk_id: line.citation?.chunk_id ?? "00000000-0000-0000-0000-000000000000",
        });
      }
    }
  }

  return findings;
}

function gateFindingsToIssues(findings: (DriftFinding | MissingAssumption)[]): Issue[] {
  return findings.map((f) => ({
    type: "scope_mismatch" as IssueType,
    severity: "error" as const,
    target_agent: "writer" as const,
    description: "field" in f ? `drift in ${f.field}: expected ${f.expected}, found ${f.found}` : `missing assumption: ${f.text}`,
    evidence_chunk_id: "00000000-0000-0000-0000-000000000000",
  }));
}

interface GatedState {
  bom: BillOfMaterials;
  proposal: ProposalDocument;
  totals: ComputedTotals;
  issues: Issue[];
}

async function runDeterministicGates(
  runId: string,
  state: LoadedState,
  deps: Deps
): Promise<GatedState> {
  const bom = JSON.parse(JSON.stringify(state.bom)) as BillOfMaterials;
  let proposal = JSON.parse(JSON.stringify(state.proposal)) as ProposalDocument;

  const issues: Issue[] = [];
  issues.push(...runGroundingGate(bom, state.chunks));

  let totals = computeTotals(bom, deps.rateMap, deps.taxRate);

  const drift = findNumericalDrift(proposal, bom, totals, state.spec);
  const missing = findMissingAssumptions(proposal, bom);

  if (drift.length > 0 || missing.length > 0) {
    const writerDeps = { pool: deps.pool, runId, taxRate: deps.taxRate };
    proposal = deps.writer
      ? await deps.writer(bom, totals, state.evidence.similar_projects, writerDeps, [])
      : await runWriter(bom, totals, state.evidence.similar_projects, writerDeps, {
          findings: drift,
          missing,
        });
  }

  totals = computeTotals(bom, deps.rateMap, deps.taxRate);
  issues.push(...gateFindingsToIssues(drift));
  issues.push(...gateFindingsToIssues(missing));

  const gated = runCodeClaimGate(proposal, state.chunks);
  proposal = gated.proposal;

  return { bom, proposal, totals, issues };
}

async function persistGatedState(
  client: PoolClient,
  runId: string,
  gated: GatedState
): Promise<void> {
  await client.query(
    "UPDATE run SET bom = $1, proposal = $2, total_cost = $3, updated_at = NOW() WHERE id = $4",
    [JSON.stringify(gated.bom), JSON.stringify(gated.proposal), gated.totals.total, runId]
  );
}

async function regenerate(
  deps: Deps,
  runId: string,
  state: LoadedState,
  issues: Issue[]
): Promise<LoadedState> {
  const grouped = groupIssues(issues);
  let bom = JSON.parse(JSON.stringify(state.bom)) as BillOfMaterials;
  let proposal = JSON.parse(JSON.stringify(state.proposal)) as ProposalDocument;
  let evidence = state.evidence;

  if (grouped.estimator.length > 0) {
    const estimatorDeps = {
      pool: deps.pool,
      retrievalCfg: deps.retrievalCfg,
      rateMap: deps.rateMap,
      taxRate: deps.taxRate,
      runId,
    };
    const outcome = deps.estimator
      ? await deps.estimator(state.spec, evidence, estimatorDeps, grouped.estimator)
      : await runEstimator(state.spec, evidence, estimatorDeps, { issues: grouped.estimator });
    bom = outcome.bom;

    const client = await deps.pool.connect();
    try {
      await appendAudit(client, runId, "estimator_regen", { bom, totals: outcome.totals });
    } finally {
      client.release();
    }
  }

  if (grouped.writer.length > 0 || grouped.estimator.length > 0) {
    const totals = computeTotals(bom, deps.rateMap, deps.taxRate);
    const writerDeps = { pool: deps.pool, runId, taxRate: deps.taxRate };
    const templates = evidence.similar_projects;
    proposal = deps.writer
      ? await deps.writer(bom, totals, templates, writerDeps, grouped.writer)
      : await runWriter(bom, totals, templates, writerDeps, { issues: grouped.writer });

    const client = await deps.pool.connect();
    try {
      await appendAudit(client, runId, "writer_regen", { proposal });
    } finally {
      client.release();
    }
  }

  const gated = await runDeterministicGates(runId, { ...state, bom, proposal }, deps);

  const client = await deps.pool.connect();
  try {
    await persistGatedState(client, runId, gated);
  } finally {
    client.release();
  }

  return { ...state, bom: gated.bom, proposal: gated.proposal };
}

async function loadLoopCap(): Promise<number> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "loop_cap.json");
  const text = await readFile(path, "utf-8");
  const parsed = JSON.parse(text);
  if (typeof parsed.cap !== "number") throw new Error("loop_cap.json must contain a numeric cap");
  return parsed.cap;
}

export async function reviewAndRegenerate(runId: string, deps: Deps): Promise<LoopState> {
  const cap = await loadLoopCap();
  let state = await loadState(deps, runId);
  let iterations = 0;
  let gateIssues: Issue[] = [];

  const initial = await runDeterministicGates(runId, state, deps);
  if (initial.issues.length > 0) {
    const client = await deps.pool.connect();
    try {
      await persistGatedState(client, runId, initial);
    } finally {
      client.release();
    }
  }
  state = { ...state, bom: initial.bom, proposal: initial.proposal };
  gateIssues = initial.issues;

  while (true) {
    const totals = computeTotals(state.bom, deps.rateMap, deps.taxRate);
    const critique = deps.reviewer
      ? await deps.reviewer({
          run_id: runId,
          round: iterations + 1,
          spec: state.spec,
          bom: state.bom,
          totals,
          proposal: state.proposal,
          evidence: state.evidence,
        })
      : await runReviewer({
          run_id: runId,
          round: iterations + 1,
          spec: state.spec,
          bom: state.bom,
          totals,
          proposal: state.proposal,
          evidence: state.evidence,
        });

    const client = await deps.pool.connect();
    try {
      await persistCritique(client, critique);
    } finally {
      client.release();
    }

    const reviewerIssues = critique.decision === "revise" ? critique.issues : [];
    const openIssues = [...gateIssues, ...reviewerIssues];

    if (openIssues.length === 0) {
      const client2 = await deps.pool.connect();
      try {
        await persistRunStatus(client2, runId, "completed");
      } finally {
        client2.release();
      }
      return { iterations, open_issues: [], status: "passed" };
    }

    if (iterations >= cap) {
      const client2 = await deps.pool.connect();
      try {
        await persistRunStatus(client2, runId, "needs_review", openIssues);
      } finally {
        client2.release();
      }
      return { iterations, open_issues: openIssues, status: "needs_review" };
    }

    iterations += 1;
    state = await regenerate(deps, runId, state, openIssues);
    gateIssues = [];
  }
}
