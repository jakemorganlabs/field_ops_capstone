import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { config } from "dotenv";
import pg from "pg";
import { createPool } from "./db.js";
import { intakeIdempotencyKey } from "./idempotency.js";
import { verifyRequest } from "./hmac.js";
import { runPipeline } from "./pipeline.js";
import {
  handleGetQueue,
  handleGetQueueRun,
  handleApprove,
  handleReject,
  handleGetPdf,
  getStatus,
} from "./gate.js";
import { fsObjectStore } from "./objectstore.js";

config();

const pool = createPool();
const port = Number(process.env.PORT ?? 3004);
const hmacSecret = process.env.HMAC_SECRET;
const objectStoreDir = process.env.OBJECT_STORE_DIR ?? "./objects";
const gateDeps = { pool, store: fsObjectStore(objectStoreDir) };

if (!hmacSecret) {
  console.error("HMAC_SECRET is not set");
  process.exit(1);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function findRunByHash(client: pg.PoolClient, hash: string): Promise<{ id: string } | null> {
  const result = await client.query("SELECT id FROM run WHERE intake_hash = $1 LIMIT 1", [hash]);
  if (result.rowCount && result.rowCount > 0) {
    return { id: result.rows[0].id };
  }
  return null;
}

async function createRun(client: pg.PoolClient, hash: string): Promise<string> {
  const result = await client.query(
    `INSERT INTO run (intake_hash, status) VALUES ($1, 'pending') RETURNING id`,
    [hash]
  );
  return result.rows[0].id;
}

async function writeAudit(client: pg.PoolClient, runId: string, hash: string): Promise<void> {
  await client.query(
    `INSERT INTO audit (run_id, table_name, record_id, action, new_value) VALUES ($1, 'run', $2, 'create', $3)`,
    [runId, runId, JSON.stringify({ intake_hash: hash, status: "pending" })]
  );
}

async function handleHealth(res: ServerResponse): Promise<void> {
  const client = await pool.connect();
  let db = "ok";
  let lastRunAge: number | null = null;
  try {
    await client.query("SELECT 1");
    const result = await client.query(
      "SELECT EXTRACT(EPOCH FROM (NOW() - created_at))::integer AS age FROM run ORDER BY created_at DESC LIMIT 1"
    );
    if (result.rowCount && result.rowCount > 0) {
      lastRunAge = result.rows[0].age;
    }
  } catch (err) {
    db = err instanceof Error ? err.message : String(err);
  } finally {
    client.release();
  }

  let objectstore = "ok";
  try {
    await fsObjectStore(objectStoreDir).exists("health-check.tmp");
  } catch (err) {
    objectstore = err instanceof Error ? err.message : String(err);
  }

  let configStatus = "ok";
  try {
    await readFile("config/extraction.json", "utf-8");
    await readFile("config/qualification_rules.json", "utf-8");
  } catch (err) {
    configStatus = err instanceof Error ? err.message : String(err);
  }

  const status = db === "ok" && objectstore === "ok" && configStatus === "ok" ? 200 : 503;
  jsonResponse(res, status, {
    db,
    objectstore,
    config: configStatus,
    last_run_age_sec: lastRunAge,
  });
}

async function handleGetRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const match = req.url?.match(/^\/run\/([0-9a-f-]+)$/);
  if (!match) {
    jsonResponse(res, 404, { error: "not found" });
    return;
  }
  const runId = match[1];
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT * FROM run WHERE id = $1 LIMIT 1", [runId]);
    if (!result.rowCount || result.rowCount === 0) {
      jsonResponse(res, 404, { error: "run not found" });
      return;
    }
    jsonResponse(res, 200, result.rows[0]);
  } finally {
    client.release();
  }
}

async function handleIntake(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const auth = req.headers["authorization"] as string | undefined;

  const verified = verifyRequest({
    secret: hmacSecret,
    method: "POST",
    path: "/intake",
    body,
    authorization: auth ?? "",
  });
  if (!verified.ok) {
    jsonResponse(res, 401, { error: verified.error });
    return;
  }

  let intake: unknown;
  try {
    intake = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: "invalid JSON body" });
    return;
  }

  const hash = intakeIdempotencyKey(intake);
  const client = await pool.connect();
  let runId: string;
  try {
    await client.query("BEGIN");
    const existing = await findRunByHash(client, hash);
    if (existing) {
      await client.query("COMMIT");
      jsonResponse(res, 202, { run_id: existing.id, status: "existing" });
      return;
    }
    runId = await createRun(client, hash);
    await writeAudit(client, runId, hash);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  runPipeline(runId, intake, pool).catch((err) => {
    // failRun inside the pipeline already persisted the failure and the
    // dead_letter row. Log only, to avoid a duplicate write.
    const error = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ event: "pipeline_failed", run_id: runId, error }));
  });

  jsonResponse(res, 202, { run_id: runId, status: "accepted" });
}

function isReviewHost(req: IncomingMessage): boolean {
  const reviewHost = process.env.REVIEW_HOST ?? "";
  if (!reviewHost) return false;
  return (req.headers.host ?? "").toLowerCase() === reviewHost.toLowerCase();
}

const server = createServer(async (req, res) => {
  try {
    if (isReviewHost(req)) {
      if (req.method === "GET" && req.url === "/queue") {
        await handleGetQueue(req, res, gateDeps);
      } else if (req.method === "GET" && req.url?.startsWith("/queue/") && req.url?.endsWith("/pdf")) {
        await handleGetPdf(req, res, gateDeps);
      } else if (req.method === "GET" && req.url?.match(/^\/queue\/[0-9a-f-]+$/)) {
        await handleGetQueueRun(req, res, gateDeps);
      } else if (req.method === "POST" && req.url?.match(/^\/queue\/[0-9a-f-]+\/approve$/)) {
        await handleApprove(req, res, gateDeps);
      } else if (req.method === "POST" && req.url?.match(/^\/queue\/[0-9a-f-]+\/reject$/)) {
        await handleReject(req, res, gateDeps);
      } else {
        jsonResponse(res, 404, { error: "not found" });
      }
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      await handleHealth(res);
    } else if (req.method === "GET" && req.url?.startsWith("/run/")) {
      await handleGetRun(req, res);
    } else if (req.method === "POST" && req.url === "/intake") {
      await handleIntake(req, res);
    } else {
      jsonResponse(res, 404, { error: "not found" });
    }
  } catch (err) {
    const status = getStatus(err);
    const error = err instanceof Error ? err.message : String(err);
    jsonResponse(res, status >= 400 && status < 600 ? status : 500, { error });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "server_start", host: "127.0.0.1", port }));
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // main entry point
}
