import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import pg from "pg";

export const ajv = new Ajv2020({ strict: false });
addFormats(ajv);

export interface JsonCallResult<T> {
  value: T;
  tokens_in: number;
  tokens_out: number;
  latency_ms: number;
  repaired: boolean;
}

interface AuditContext {
  run_id: string;
  stage: string;
}

export class SchemaFailure extends Error {
  rawOutputs: string[];
  constructor(message: string, rawOutputs: string[]) {
    super(message);
    this.rawOutputs = rawOutputs;
  }
}

/**
 * Repair the shapes the Gemma judge actually returns before validation.
 * Observed on DeepInfra with response_format json_object: a stray ")}" token
 * glued to the first key inside the wrapper ({"scores": {")}scope_completeness": 5}),
 * the wrapper key itself replaced by a junk key with the real name as its value
 * ({")} { ": "scores", "value": {...}}), the excerpt placed beside the wrapper
 * instead of inside it, and scores written as strings. Each one failed the
 * schema on all three attempts and left the semantic metrics unmeasured (37
 * judge-schema failures on the 50-case eval). The rules here are structural
 * only: keys are cleaned, the object holding the required fields is located
 * wherever it sits, numeric strings become numbers. No score is invented.
 */
export function normalizeJudgePayload(parsed: unknown, wrapperKey: string, schema: object): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const required = requiredFields(schema);
  const numericFields = numberFields(schema);
  const cleaned = cleanKeys(parsed) as Record<string, unknown>;

  let inner: Record<string, unknown> | null = null;
  const direct = cleaned[wrapperKey];
  if (direct && typeof direct === "object" && !Array.isArray(direct) && hasAll(direct as Record<string, unknown>, required)) {
    inner = direct as Record<string, unknown>;
  } else {
    inner = findObjectWith(cleaned, required);
  }
  if (!inner) return cleaned;

  for (const field of numericFields) {
    const v = inner[field];
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
      inner[field] = Number(v);
    }
  }
  if (inner.excerpt === undefined) {
    const stray = cleaned.excerpt ?? cleaned.supporting_excerpt ?? inner.supporting_excerpt;
    if (typeof stray === "string") inner.excerpt = stray;
  }
  return { ...cleaned, [wrapperKey]: inner };
}

function cleanKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const k = key.replace(/^[^A-Za-z_]+/, "").replace(/[^A-Za-z0-9_]+$/, "").trim();
    out[k === "" ? key.trim() : k] = cleanKeys(v);
  }
  return out;
}

function hasAll(obj: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((f) => obj[f] !== undefined);
}

function findObjectWith(value: unknown, fields: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectWith(item, fields);
      if (found) return found;
    }
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (fields.length > 0 && hasAll(obj, fields)) return obj;
  for (const v of Object.values(obj)) {
    const found = findObjectWith(v, fields);
    if (found) return found;
  }
  return null;
}

function numberFields(schema: object): string[] {
  const props = (schema as { properties?: Record<string, { type?: string }> }).properties ?? {};
  return Object.entries(props)
    .filter(([, def]) => def && (def.type === "number" || def.type === "integer"))
    .map(([name]) => name);
}

export async function judgeJson<T>(opts: {
  system: string;
  user: string;
  wrapperKey: string;
  schema: object;
  maxTokens: number;
}): Promise<JsonCallResult<T>> {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPINFRA_API_KEY is not set");
  }

  const modelId = process.env.JUDGE_MODEL_ID;
  if (!modelId) {
    throw new Error("JUDGE_MODEL_ID is not set");
  }

  const wrapperSchema = {
    type: "object",
    additionalProperties: true,
    required: [opts.wrapperKey],
    properties: {
      [opts.wrapperKey]: opts.schema,
    },
  };
  const validate = ajv.compile(wrapperSchema);

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  const url = "https://api.deepinfra.com/v1/openai/chat/completions";
  const rawOutputs: string[] = [];
  let repaired = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt >= 1) {
      repaired = true;
      const fields = requiredFields(opts.schema);
      const repairPrompt = `The previous response failed validation. Errors: ${JSON.stringify(
        validate.errors ?? []
      )}. Return one JSON object with the single top-level key "${opts.wrapperKey}". Never return an empty object. The value of "${opts.wrapperKey}" must be an object that contains every required field: ${fields.join(
        ", "
      )}. Use "" and 0, not null.`;
      messages.push({ role: "user", content: repairPrompt });
    }

    const started = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: opts.maxTokens,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const latency_ms = Date.now() - started;

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`judge API returned HTTP ${response.status}: ${text}`);
    }

    const json = (await response.json()) as DeepInfraResponse;
    const raw = json.choices?.[0]?.message?.content ?? "";
    rawOutputs.push(raw);

    let parsed: unknown;
    try {
      parsed = normalizeJudgePayload(JSON.parse(raw), opts.wrapperKey, opts.schema);
    } catch {
      continue;
    }

    if (validate(parsed)) {
      const value = (parsed as Record<string, unknown>)[opts.wrapperKey] as T;
      return {
        value,
        tokens_in: json.usage?.prompt_tokens ?? 0,
        tokens_out: json.usage?.completion_tokens ?? 0,
        latency_ms,
        repaired,
      };
    }
  }

  throw new SchemaFailure("judge schema validation failed after repair", rawOutputs);
}

interface DeepInfraChoice {
  message?: {
    content?: string;
  };
}

interface DeepInfraResponse {
  choices?: DeepInfraChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

function requiredFields(schema: object): string[] {
  if (
    schema &&
    typeof schema === "object" &&
    "required" in schema &&
    Array.isArray((schema as Record<string, unknown>).required)
  ) {
    return (schema as Record<string, unknown>).required as string[];
  }
  return [];
}

/**
 * Call the DeepInfra generation API and validate the response against a schema.
 * The prompt must ask for a wrapper object, for example {"spec": {...}}.
 * On schema failure, make one repair call that includes Ajv errors and restates
 * the wrapper key and required fields.
 */
async function writeAuditTokens(runId: string, stage: string, tokensIn: number, tokensOut: number): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return;
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO audit (run_id, table_name, record_id, action, new_value, tokens_in, tokens_out)
         VALUES ($1, 'run', $2, $3, $4, $5, $6)`,
        [runId, runId, `${stage}_tokens`, JSON.stringify({ stage, tokens_in: tokensIn, tokens_out: tokensOut }), tokensIn, tokensOut]
      );
    } finally {
      client.release();
    }
  } catch {
    // Audit logging must not break model calls.
  } finally {
    await pool.end();
  }
}

export async function generateJson<T>(opts: {
  system: string;
  user: string;
  wrapperKey: string;
  schema: object;
  maxTokens: number;
  audit?: AuditContext;
}): Promise<JsonCallResult<T>> {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPINFRA_API_KEY is not set");
  }

  const modelId = process.env.GENERATION_MODEL_ID;
  if (!modelId) {
    throw new Error("GENERATION_MODEL_ID is not set");
  }

  const wrapperSchema = {
    type: "object",
    additionalProperties: true,
    required: [opts.wrapperKey],
    properties: {
      [opts.wrapperKey]: opts.schema,
    },
  };
  const validate = ajv.compile(wrapperSchema);

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];

  const url = "https://api.deepinfra.com/v1/openai/chat/completions";
  const rawOutputs: string[] = [];
  let repaired = false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt >= 1) {
      repaired = true;
      const fields = requiredFields(opts.schema);
      const repairPrompt = `The previous response failed validation. Errors: ${JSON.stringify(
        validate.errors ?? []
      )}. Return one JSON object with the single top-level key "${opts.wrapperKey}". Never return an empty object. The value of "${opts.wrapperKey}" must be an object that contains every required field: ${fields.join(
        ", "
      )}. Use "" and 0, not null.`;
      messages.push({ role: "user", content: repairPrompt });
    }

    const started = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: modelId,
        messages,
        temperature: 0,
        response_format: { type: "json_object" },
        max_tokens: opts.maxTokens,
      }),
      signal: AbortSignal.timeout(120000),
    });
    const latency_ms = Date.now() - started;

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`generation API returned HTTP ${response.status}: ${text}`);
    }

    const json = (await response.json()) as DeepInfraResponse;
    const raw = json.choices?.[0]?.message?.content ?? "";
    rawOutputs.push(raw);

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    if (validate(parsed)) {
      const value = (parsed as Record<string, unknown>)[opts.wrapperKey] as T;
      const tokensIn = json.usage?.prompt_tokens ?? 0;
      const tokensOut = json.usage?.completion_tokens ?? 0;
      if (opts.audit) {
        await writeAuditTokens(opts.audit.run_id, opts.audit.stage, tokensIn, tokensOut);
      }
      return {
        value,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        latency_ms,
        repaired,
      };
    }
  }

  throw new SchemaFailure("schema validation failed after repair", rawOutputs);
}
