import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { generateJson, SchemaFailure } from "./llm.js";
import type { ProjectSpec, QualificationRules, RouteResult } from "./qualification.js";
import { qualify } from "./qualification.js";
import { logStage } from "./log.js";
import {
  buildIntentQueries,
  retrieveIntent,
  type Intent,
  type IntentResult,
  type RetrievalCfg,
} from "./retrieval.js";
import { runEstimator } from "./agents/estimator.js";
import { runWriter } from "./agents/writer.js";
import { reviewAndRegenerate } from "./review_loop.js";

export interface ExtractedSpec extends ProjectSpec {
  confidence: number;
  raw_text?: string;
}

interface ExtractionConfig {
  conf_floor: number;
}

interface PipelineContext {
  run_id: string;
  intake: unknown;
  pool: Pool;
}

interface RouteDecision {
  action: "proceed" | "clarify" | "reject";
  score: number;
  reasons: string[];
  missing_fields: string[];
}

export async function runPipeline(run_id: string, intake: unknown, pool: Pool): Promise<void> {
  const ctx: PipelineContext = { run_id, intake, pool };
  try {
    await runExtraction(ctx);
    await completeProposal(ctx);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await failRun(ctx, error);
    throw err;
  }
}

async function runExtraction(ctx: PipelineContext): Promise<void> {
  const extractionCfg = await loadExtractionConfig();
  const rules = await loadQualificationRules();

  const schema = await loadProjectSpecSchema();
  const started = Date.now();
  const result = await generateJson<ExtractedSpec>({
    system: buildExtractionSystemPrompt(schema),
    user: JSON.stringify(ctx.intake, null, 2),
    wrapperKey: "spec",
    schema,
    maxTokens: 2048,
    audit: { run_id: ctx.run_id, stage: "extraction" },
  });
  const latency_ms = Date.now() - started;

  logStage({
    run_id: ctx.run_id,
    stage: "extraction",
    status: "ok",
    latency_ms,
    model_id: process.env.GENERATION_MODEL_ID,
    tokens_in: result.tokens_in,
    tokens_out: result.tokens_out,
  });

  const decision = decideRoute(result.value, extractionCfg, rules);

  logStage({
    run_id: ctx.run_id,
    stage: "qualification",
    status: decision.action,
    latency_ms: 0,
    gate_fired: decision.action === "proceed" ? undefined : decision.action,
  });

  await writeSpecAndRun(ctx, result.value, decision);
}

/**
 * Advance a proceed-qualified run through retrieval, estimation, proposal
 * writing, and the review loop, which sets the terminal status. Runs that
 * qualified as clarify or reject are already terminal and are left untouched.
 */
async function completeProposal(ctx: PipelineContext): Promise<void> {
  const { pool, run_id } = ctx;

  let status: string;
  let specId: string | null;
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT status, spec_id FROM run WHERE id = $1", [run_id]);
    status = result.rows[0].status;
    specId = result.rows[0].spec_id;
  } finally {
    client.release();
  }

  if (status !== "running" || !specId) return;

  let spec: ProjectSpec;
  const specClient = await pool.connect();
  try {
    const specResult = await specClient.query("SELECT * FROM spec WHERE id = $1", [specId]);
    spec = specResult.rows[0] as ProjectSpec;
  } finally {
    specClient.release();
  }

  const retrievalCfg = await buildRetrievalCfg(pool);
  const rateMap = JSON.parse(await readConfig("labor_rates.json")) as Record<string, string>;
  const taxRate = String((JSON.parse(await readConfig("tax.json")) as { rate: string }).rate);

  const queries = buildIntentQueries(spec);
  const intents: Intent[] = ["similar_projects", "manufacturer_specs", "code_references"];
  const evidence = {} as Record<Intent, IntentResult>;
  for (const intent of intents) {
    evidence[intent] = await retrieveIntent(intent, queries[intent], {}, retrievalCfg);
  }

  const estimatorOutcome = await runEstimator(spec, evidence, {
    pool,
    retrievalCfg,
    rateMap,
    taxRate,
    runId: run_id,
  });

  await runWriter(estimatorOutcome.bom, estimatorOutcome.totals, evidence.similar_projects, {
    pool,
    runId: run_id,
    taxRate,
  });

  await reviewAndRegenerate(run_id, { pool, retrievalCfg, rateMap, taxRate });
}

function decideRoute(spec: ExtractedSpec, extractionCfg: ExtractionConfig, rules: QualificationRules): RouteDecision {
  if (!Number.isFinite(spec.confidence) || spec.confidence < extractionCfg.conf_floor) {
    return {
      action: "clarify",
      score: Math.round((spec.confidence ?? 0) * 100),
      reasons: ["extraction confidence below floor"],
      missing_fields: deriveMissingFields(spec, rules),
    };
  }

  const route = qualify(spec, rules);
  return {
    action: route.action,
    score: route.score,
    reasons: route.reasons,
    missing_fields: route.missing_fields,
  };
}

function deriveMissingFields(spec: ProjectSpec, rules: QualificationRules): string[] {
  const missing: string[] = [];
  for (const field of rules.required_fields) {
    const value = (spec as Record<string, unknown>)[field];
    if (!isPresent(value)) {
      missing.push(field);
    }
  }
  if (rules.min_materials !== undefined) {
    const materials = Array.isArray(spec.materials) ? spec.materials : [];
    if (materials.length < rules.min_materials) {
      missing.push("materials_count");
    }
  }
  if (rules.min_labor !== undefined) {
    const labor = Array.isArray(spec.labor) ? spec.labor : [];
    if (labor.length < rules.min_labor) {
      missing.push("labor_count");
    }
  }
  return missing;
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}

async function writeSpecAndRun(ctx: PipelineContext, spec: ExtractedSpec, decision: RouteDecision): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query("BEGIN");

    const specResult = await client.query(
      `INSERT INTO spec (
        project_name, client_name, location, region, start_date, end_date,
        scope, materials, labor, constraints, notes, raw_text, confidence
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id`,
      [
        spec.project_name ?? "",
        spec.client_name ?? null,
        spec.location ?? null,
        spec.region ?? null,
        spec.start_date ?? null,
        spec.end_date ?? null,
        spec.scope ?? "",
        JSON.stringify(spec.materials ?? []),
        JSON.stringify(spec.labor ?? []),
        JSON.stringify(spec.constraints ?? []),
        spec.notes ?? null,
        spec.raw_text ?? JSON.stringify(ctx.intake),
        spec.confidence ?? 0,
      ]
    );
    const spec_id = specResult.rows[0].id;

    let status: string;
    if (decision.action === "proceed") status = "running";
    else if (decision.action === "reject") status = "rejected";
    else status = "completed";

    const proposal = {
      route: decision.action,
      score: decision.score,
      reasons: decision.reasons,
      missing_fields: decision.missing_fields,
    };

    await client.query(
      `UPDATE run SET status = $1, spec_id = $2, proposal = $3, updated_at = NOW() WHERE id = $4`,
      [status, spec_id, JSON.stringify(proposal), ctx.run_id]
    );

    await client.query(
      `INSERT INTO audit (run_id, table_name, record_id, action, new_value)
       VALUES ($1, 'run', $2, 'qualification', $3)`,
      [ctx.run_id, ctx.run_id, JSON.stringify({ route: decision.action, score: decision.score, reasons: decision.reasons })]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function failRun(ctx: PipelineContext, error: string): Promise<void> {
  const client = await ctx.pool.connect();
  try {
    await client.query(
      `UPDATE run SET status = 'failed', error = $1, updated_at = NOW() WHERE id = $2`,
      [error, ctx.run_id]
    );
    await client.query(
      `INSERT INTO dead_letter (run_id, payload, error, last_error) VALUES ($1, $2, $3, $3)`,
      [ctx.run_id, JSON.stringify({ intake: ctx.intake }), error]
    );
  } finally {
    client.release();
  }
}

async function buildRetrievalCfg(pool: Pool): Promise<RetrievalCfg> {
  const cfg = JSON.parse(await readConfig("retrieval.json")) as {
    floors: Record<Intent, number>;
    max_chunks_per_query: number;
  };
  return {
    pool,
    embedCfg: {
      baseUrl: process.env.EMBEDDING_BASE_URL ?? "",
      modelId: process.env.EMBEDDING_MODEL_ID ?? "",
      dimensions: Number(process.env.EMBEDDING_DIMENSIONS ?? 1536),
      apiKey: process.env.DEEPINFRA_API_KEY ?? "",
    },
    floors: cfg.floors,
    maxChunks: cfg.max_chunks_per_query,
  };
}

async function readConfig(name: string): Promise<string> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "config", name);
  return readFile(path, "utf-8");
}

async function loadProjectSpecSchema(): Promise<object> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "project_spec.json");
  const text = await readFile(path, "utf-8");
  return JSON.parse(text);
}

async function loadExtractionConfig(): Promise<ExtractionConfig> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "extraction.json");
  const text = await readFile(path, "utf-8");
  return JSON.parse(text) as ExtractionConfig;
}

async function loadQualificationRules(): Promise<QualificationRules> {
  const path = join(dirname(fileURLToPath(import.meta.url)), "..", "config", "qualification_rules.json");
  const text = await readFile(path, "utf-8");
  return JSON.parse(text) as QualificationRules;
}

function buildExtractionSystemPrompt(schema: object): string {
  const properties = (schema as Record<string, unknown>).properties as Record<string, unknown>;
  const fields = Object.keys(properties ?? {});
  const required = Array.isArray((schema as Record<string, unknown>).required)
    ? ((schema as Record<string, unknown>).required as string[])
    : [];

  return `You extract a structured project spec from the intake. Return a JSON object with wrapper key "spec". Required fields: ${required.join(", ")}. Optional fields: ${fields.join(", ")}.

Extract only what the intake states. Do not invent values. If a field is present in the intake, copy it exactly. If an optional field is missing, omit it. If a required string field is missing, use "". If an array field is missing, use []. Set missing confidence to 0. Do not use null.

Set "confidence" between 0 and 1 to reflect how certain you are that the extracted values match the intake. A clear, unambiguous intake should have high confidence even if it is incomplete. Use low confidence only when the intake is vague, ambiguous, or unclear.`;
}
