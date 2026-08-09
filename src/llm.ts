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
    additionalProperties: false,
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 1) {
      repaired = true;
      const fields = requiredFields(opts.schema);
      const repairPrompt = `The previous response failed validation. Errors: ${JSON.stringify(
        validate.errors ?? []
      )}. Restate the wrapper key "${opts.wrapperKey}". List every required field: ${fields.join(
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
      signal: AbortSignal.timeout(300000),
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
      parsed = JSON.parse(raw);
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

export async function gemmaJson<T>(opts: {
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
    additionalProperties: false,
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

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt === 1) {
      repaired = true;
      const fields = requiredFields(opts.schema);
      const repairPrompt = `The previous response failed validation. Errors: ${JSON.stringify(
        validate.errors ?? []
      )}. Restate the wrapper key "${opts.wrapperKey}". List every required field: ${fields.join(
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
      signal: AbortSignal.timeout(300000),
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
