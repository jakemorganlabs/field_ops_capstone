import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { Decimal } from "decimal.js";
import type { ObjectStore } from "./objectstore.js";
import { renderProposalPdf } from "./pdf.js";
import { materialSubtotal, laborTotal, proposalTotal } from "./calculator.js";

export interface PendingEdit {
  target: "line" | "prose";
  field_path: string;
  new_value: string;
}

export interface Deps {
  pool: Pool;
  store: ObjectStore;
}

interface LoadedRateConfig {
  rateMap: Record<string, string>;
  taxRate: string;
}

let rateConfigCache: LoadedRateConfig | null = null;

async function loadRateConfig(): Promise<LoadedRateConfig> {
  if (rateConfigCache) return rateConfigCache;
  const base = dirname(fileURLToPath(import.meta.url));
  const [ratesText, taxText] = await Promise.all([
    readFile(join(base, "..", "config", "labor_rates.json"), "utf-8"),
    readFile(join(base, "..", "config", "tax.json"), "utf-8"),
  ]);
  const rateMap = JSON.parse(ratesText) as Record<string, string>;
  const taxRate = String((JSON.parse(taxText) as { rate: string }).rate);
  rateConfigCache = { rateMap, taxRate };
  return rateConfigCache;
}

export function requireApprover(req: IncomingMessage): string {
  const reviewHost = process.env.REVIEW_HOST ?? "";
  const host = (req.headers.host ?? "").toLowerCase();
  const isReviewHost = reviewHost.length > 0 && host === reviewHost.toLowerCase();
  if (!isReviewHost) {
    throw httpError(403, "review host required");
  }
  const production = process.env.NODE_ENV === "production";
  const email = production
    ? (req.headers["cf-access-authenticated-user-email"] as string | undefined)
    : process.env.APPROVER_DEV_EMAIL;
  if (!email || email.trim() === "") {
    throw httpError(403, "approver identity required");
  }
  return email.trim();
}

function httpError(status: number, message: string): Error {
  const err = new Error(message);
  (err as unknown as { status: number }).status = status;
  return err;
}

export function getStatus(err: unknown): number {
  if (err && typeof err === "object" && "status" in err && typeof (err as { status: unknown }).status === "number") {
    return (err as { status: number }).status;
  }
  return 500;
}

function jsonResponse(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function htmlResponse(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
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

interface QueueRow {
  id: string;
  status: string;
  proposal: { summary?: string } | null;
  total_cost: string | null;
  age_seconds: number;
}

export async function listQueue(client: PoolClient): Promise<QueueRow[]> {
  const result = await client.query(
    `SELECT id, status, proposal, total_cost,
      EXTRACT(EPOCH FROM (NOW() - created_at))::integer AS age_seconds
     FROM run
     WHERE status IN ('needs_review', 'complete', 'completed')
     ORDER BY CASE WHEN status = 'needs_review' THEN 0 ELSE 1 END, created_at DESC`
  );
  return result.rows as QueueRow[];
}

function queueItemHtml(row: QueueRow): string {
  const summary = row.proposal?.summary ?? "(no summary)";
  const cost = row.total_cost ?? "-";
  const badgeClass = row.status === "needs_review" ? "badge-review" : "badge-complete";
  return `<tr>
  <td><a href="/queue/${row.id}">${row.id}</a></td>
  <td><span class="badge ${badgeClass}">${escapeHtml(row.status)}</span></td>
  <td>${escapeHtml(summary)}</td>
  <td>${escapeHtml(cost)}</td>
  <td>${escapeHtml(formatAge(row.age_seconds))}</td>
</tr>`;
}

export async function renderQueue(client: PoolClient): Promise<string> {
  const rows = await listQueue(client);
  const rowsHtml = rows.length === 0 ? "<tr><td colspan=\"5\">No runs in queue.</td></tr>" : rows.map(queueItemHtml).join("\n");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Review Queue</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; }
    th { background: #f5f5f5; }
    .badge { padding: 0.2rem 0.5rem; border-radius: 0.25rem; font-size: 0.85rem; }
    .badge-review { background: #fff3cd; color: #856404; }
    .badge-complete { background: #d4edda; color: #155724; }
  </style>
</head>
<body>
  <h1>Review Queue</h1>
  <table>
    <thead>
      <tr><th>Run</th><th>Status</th><th>Summary</th><th>Cost</th><th>Age</th></tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
</body>
</html>`;
}

interface RunDetail {
  id: string;
  status: string;
  proposal: {
    summary?: string;
    terms?: string;
    valid_until?: string;
    line_items?: { description: string; amount: string; quantity?: string; unit_price?: string }[];
    labor_total?: string;
    material_subtotal?: string;
    tax_rate?: string;
    tax_amount?: string;
    total?: string;
    assumptions?: string[];
    code_claims?: { claim: string; chunk_id: string; snippet: string }[];
  } | null;
  bom: {
    lines: {
      item: string;
      quantity: string;
      unit_cost: string;
      unit?: string;
      citation?: { chunk_id: string; snippet: string };
      assumption?: boolean;
      note?: string;
    }[];
    labor?: {
      role: string;
      hours: string;
      rate_key: string;
      citation?: { chunk_id: string; snippet: string };
      assumption?: boolean;
      note?: string;
    }[];
  } | null;
  total_cost: string | null;
  critique: { issues: { type: string; severity: string; description: string }[] } | null;
  approved_by: string | null;
  approved_at: string | null;
  pdf_key: string | null;
}

export async function getRunDetail(client: PoolClient, runId: string): Promise<RunDetail | null> {
  const result = await client.query(
    `SELECT id, status, proposal, bom, total_cost, critique, approved_by, approved_at, pdf_key
     FROM run WHERE id = $1 LIMIT 1`,
    [runId]
  );
  if (!result.rowCount || result.rowCount === 0) return null;
  return result.rows[0] as RunDetail;
}

export async function getCritiqueHistory(client: PoolClient, runId: string): Promise<{ round: number; verdict: string; issues: unknown[] }[]> {
  const result = await client.query(
    `SELECT round, verdict, issues FROM critique WHERE run_id = $1 ORDER BY round ASC`,
    [runId]
  );
  return result.rows.map((r) => ({
    round: r.round,
    verdict: r.verdict,
    issues: Array.isArray(r.issues) ? r.issues : [],
  }));
}

function renderBomLine(line: NonNullable<RunDetail["bom"]>["lines"][number], index: number): string {
  const citation = line.citation
    ? `<details><summary>Citation</summary><p>Chunk: ${escapeHtml(line.citation.chunk_id)}</p><blockquote>${escapeHtml(line.citation.snippet)}</blockquote></details>`
    : "";
  const assumption = line.assumption ? `<span class="badge badge-review">assumption: ${escapeHtml(line.note ?? "")}</span>` : "";
  return `<tr>
  <td>${escapeHtml(line.item)}</td>
  <td>${escapeHtml(line.quantity)}</td>
  <td>${escapeHtml(line.unit_cost)}</td>
  <td>${escapeHtml(line.unit ?? "")}</td>
  <td>${assumption}</td>
  <td>${citation}</td>
</tr>`;
}

function renderLaborLine(line: NonNullable<RunDetail["bom"]>["labor"][number], index: number): string {
  const citation = line.citation
    ? `<details><summary>Citation</summary><p>Chunk: ${escapeHtml(line.citation.chunk_id)}</p><blockquote>${escapeHtml(line.citation.snippet)}</blockquote></details>`
    : "";
  const assumption = line.assumption ? `<span class="badge badge-review">assumption: ${escapeHtml(line.note ?? "")}</span>` : "";
  return `<tr>
  <td>${escapeHtml(line.role)}</td>
  <td>${escapeHtml(line.hours)}</td>
  <td>${escapeHtml(line.rate_key)}</td>
  <td>${assumption}</td>
  <td>${citation}</td>
</tr>`;
}

export async function renderRunDetail(client: PoolClient, runId: string): Promise<string | null> {
  const run = await getRunDetail(client, runId);
  if (!run) return null;
  const history = await getCritiqueHistory(client, runId);

  const proposal = run.proposal ?? {};
  const bom = run.bom ?? { lines: [] };
  const assumptions = proposal.assumptions ?? [];
  const openIssues = run.critique?.issues ?? [];

  const linesHtml = (bom.lines ?? []).map(renderBomLine).join("\n");
  const laborHtml = (bom.labor ?? []).map(renderLaborLine).join("\n");
  const assumptionsHtml = assumptions.length === 0
    ? "<p>None.</p>"
    : `<ul>${assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join("")}</ul>`;

  const historyHtml = history.length === 0
    ? "<p>No critique rounds.</p>"
    : history.map((h) => {
        const issueList = Array.isArray(h.issues) && h.issues.length > 0
          ? `<ul>${h.issues.map((i: { type?: string; description?: string }) => `<li>${escapeHtml(i.type ?? "")}: ${escapeHtml(i.description ?? "")}</li>`).join("")}</ul>`
          : "<p>No issues.</p>";
        return `<div class="critique-round"><h3>Round ${h.round} (${escapeHtml(h.verdict)})</h3>${issueList}</div>`;
      }).join("\n");

  const openIssuesHtml = openIssues.length === 0
    ? "<p>No open issues.</p>"
    : `<ul>${openIssues.map((i: { type?: string; description?: string }) => `<li>${escapeHtml(i.type ?? "")}: ${escapeHtml(i.description ?? "")}</li>`).join("")}</ul>`;

  const footer = `<div class="footer">
  <p>Total cost: ${escapeHtml(run.total_cost ?? "-")}</p>
  <p>Status: ${escapeHtml(run.status)} ${run.approved_by ? `(approved by ${escapeHtml(run.approved_by)} at ${escapeHtml(String(run.approved_at))})` : ""}</p>
  ${run.pdf_key ? `<p><a href="/queue/${run.id}/pdf">Download PDF</a></p>` : ""}
</div>`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Run ${run.id}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { border: 1px solid #ccc; padding: 0.5rem; text-align: left; vertical-align: top; }
    th { background: #f5f5f5; }
    .badge { padding: 0.2rem 0.5rem; border-radius: 0.25rem; font-size: 0.85rem; }
    .badge-review { background: #fff3cd; color: #856404; }
    .badge-complete { background: #d4edda; color: #155724; }
    .critique-round { border: 1px solid #ddd; padding: 1rem; margin: 1rem 0; }
    .footer { margin-top: 2rem; border-top: 2px solid #333; padding-top: 1rem; }
    details { margin-top: 0.25rem; }
  </style>
</head>
<body>
  <h1>Run ${escapeHtml(run.id)}</h1>
  <h2>Proposal</h2>
  <p>${escapeHtml(proposal.summary ?? "")}</p>
  <h3>Terms</h3>
  <p>${escapeHtml(proposal.terms ?? "")}</p>
  <p>Valid until: ${escapeHtml(proposal.valid_until ?? "")}</p>

  <h2>Bill of Materials</h2>
  <table>
    <thead><tr><th>Item</th><th>Quantity</th><th>Unit Cost</th><th>Unit</th><th>Assumption</th><th>Citation</th></tr></thead>
    <tbody>${linesHtml}</tbody>
  </table>

  ${bom.labor && bom.labor.length > 0 ? `<h2>Labor</h2>
  <table>
    <thead><tr><th>Role</th><th>Hours</th><th>Rate Key</th><th>Assumption</th><th>Citation</th></tr></thead>
    <tbody>${laborHtml}</tbody>
  </table>` : ""}

  <h2>Assumptions</h2>
  ${assumptionsHtml}

  <h2>Critique History</h2>
  ${historyHtml}

  <h2>Open Issues</h2>
  ${openIssuesHtml}

  ${footer}
</body>
</html>`;
}

function parseFieldPath(path: string): { array: string; index: number; field: string } | null {
  const match = path.match(/^([a-zA-Z]+)\[(\d+)\]\.(\w+)$/);
  if (!match) return null;
  return { array: match[1], index: Number(match[2]), field: match[3] };
}

function getLineValue(line: Record<string, unknown>, field: string): string {
  const value = line[field];
  if (value === undefined || value === null) return "";
  return String(value);
}

function applyLineEdit(bom: NonNullable<RunDetail["bom"]>, edit: PendingEdit): { before: string; after: string } {
  const parsed = parseFieldPath(edit.field_path);
  if (!parsed) throw httpError(400, `invalid field path ${edit.field_path}`);
  const arrayName = parsed.array;
  const arr = arrayName === "labor" ? (bom.labor ?? []) : (bom.lines ?? []);
  if (parsed.index < 0 || parsed.index >= arr.length) {
    throw httpError(400, `index out of range ${edit.field_path}`);
  }
  const line = arr[parsed.index];
  const before = getLineValue(line as Record<string, unknown>, parsed.field);
  (line as Record<string, unknown>)[parsed.field] = edit.new_value;
  line.assumption = true;
  line.note = line.note ? `human_edited; ${line.note}` : "human_edited";
  line.citation = undefined;
  return { before, after: edit.new_value };
}

function applyProseEdit(proposal: NonNullable<RunDetail["proposal"]>, edit: PendingEdit): { before: string; after: string } {
  const before = proposal[edit.field_path as keyof typeof proposal] ?? "";
  (proposal as Record<string, unknown>)[edit.field_path] = edit.new_value;
  return { before: String(before), after: edit.new_value };
}

function recomputeTotals(bom: NonNullable<RunDetail["bom"]>, rateMap: Record<string, string>, taxRate: string): { materials: string; labor: string; tax: string; total: string } {
  const materials = materialSubtotal(bom.lines.map((l) => ({ item: l.item, quantity: l.quantity, unit_cost: l.unit_cost })));
  const labor = bom.labor ? laborTotal(bom.labor.map((l) => ({ role: l.role, hours: l.hours, rate_key: l.rate_key })), rateMap) : "0.00";
  const total = proposalTotal(materials, labor, taxRate);
  const base = new Decimal(materials).plus(new Decimal(labor));
  const tax = base.mul(new Decimal(taxRate)).toDecimalPlaces(2).toFixed(2);
  return { materials, labor, tax, total };
}

async function persistHumanEdit(
  client: PoolClient,
  runId: string,
  edit: PendingEdit,
  before: string,
  after: string,
  approver: string
): Promise<void> {
  await client.query(
    `INSERT INTO human_edits (run_id, target, field_path, old_value, new_value, reason, applied)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
    [runId, edit.target, edit.field_path, before, after, "human_edited"]
  );
  await client.query(
    `INSERT INTO audit (run_id, table_name, record_id, action, new_value, actor)
     VALUES ($1, 'human_edits', $2, 'edit', $3, $4)`,
    [runId, runId, JSON.stringify({ target: edit.target, field_path: edit.field_path, before, after }), approver]
  );
}

export async function approveRun(
  runId: string,
  approver: string,
  edits: PendingEdit[],
  deps: Deps
): Promise<{ status: "delivered"; pdf_key: string }> {
  const { rateMap, taxRate } = await loadRateConfig();
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    const runResult = await client.query(
      `SELECT id, status, proposal, bom, total_cost FROM run WHERE id = $1 FOR UPDATE`,
      [runId]
    );
    if (!runResult.rowCount || runResult.rowCount === 0) {
      throw httpError(404, "run not found");
    }
    const run = runResult.rows[0] as { id: string; status: string; proposal: RunDetail["proposal"]; bom: RunDetail["bom"]; total_cost: string | null };

    if (run.status === "delivered" || run.status === "approved") {
      const existing = await client.query("SELECT pdf_key FROM run WHERE id = $1", [runId]);
      await client.query("COMMIT");
      return { status: "delivered", pdf_key: existing.rows[0]?.pdf_key ?? "" };
    }

    if (run.status !== "needs_review" && run.status !== "complete" && run.status !== "completed") {
      throw httpError(409, `cannot approve run with status ${run.status}`);
    }

    const proposal = run.proposal ?? { run_id: runId, bom_id: runId, summary: "", assumptions: [], code_claims: [] };
    const bom = run.bom ?? { lines: [] };

    for (const edit of edits) {
      let change: { before: string; after: string };
      if (edit.target === "line") {
        change = applyLineEdit(bom, edit);
      } else if (edit.target === "prose") {
        change = applyProseEdit(proposal, edit);
      } else {
        throw httpError(400, `unknown edit target ${edit.target}`);
      }
      await persistHumanEdit(client, runId, edit, change.before, change.after, approver);
    }

    const totals = recomputeTotals(bom, rateMap, taxRate);
    proposal.material_subtotal = totals.materials;
    proposal.labor_total = totals.labor;
    proposal.tax_rate = taxRate;
    proposal.tax_amount = totals.tax;
    proposal.total = totals.total;
    proposal.assumptions = buildAssumptions(bom);

    const pdfBuffer = await renderProposalPdf({ run_id: runId, proposal, bom, totals });
    const hash = createHash("sha256").update(pdfBuffer).digest("hex");
    const pdfKey = `proposals/${runId}_${hash}.pdf`;
    await deps.store.put(pdfKey, pdfBuffer, "application/pdf");

    await client.query(
      `UPDATE run SET status = 'delivered', approved_by = $1, approved_at = NOW(),
       pdf_key = $2, proposal = $3, bom = $4, total_cost = $5, updated_at = NOW()
       WHERE id = $6`,
      [approver, pdfKey, JSON.stringify(proposal), JSON.stringify(bom), totals.total, runId]
    );

    await client.query(
      `INSERT INTO audit (run_id, table_name, record_id, action, new_value, actor)
       VALUES ($1, 'run', $2, 'approve', $3, $4)`,
      [runId, runId, JSON.stringify({ status: "delivered", pdf_key: pdfKey }), approver]
    );

    await client.query("COMMIT");
    return { status: "delivered", pdf_key: pdfKey };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function buildAssumptions(bom: NonNullable<RunDetail["bom"]>): string[] {
  const assumptions: string[] = [];
  for (const line of bom.lines ?? []) {
    if (line.assumption) {
      assumptions.push(line.note ? `${line.item}: ${line.note}` : line.item);
    }
  }
  for (const line of bom.labor ?? []) {
    if (line.assumption) {
      assumptions.push(line.note ? `${line.role}: ${line.note}` : line.role);
    }
  }
  return assumptions;
}

export async function rejectRun(
  runId: string,
  approver: string,
  reason: string,
  deps: Deps
): Promise<void> {
  if (!reason || reason.trim() === "") {
    throw httpError(400, "rejection_reason is required");
  }
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");

    const runResult = await client.query("SELECT status FROM run WHERE id = $1 FOR UPDATE", [runId]);
    if (!runResult.rowCount || runResult.rowCount === 0) {
      throw httpError(404, "run not found");
    }
    const status = runResult.rows[0].status as string;
    if (status === "rejected") {
      await client.query("COMMIT");
      return;
    }
    if (status !== "needs_review" && status !== "complete" && status !== "completed") {
      throw httpError(409, `cannot reject run with status ${status}`);
    }

    await client.query(
      `INSERT INTO feedback (run_id, comment) VALUES ($1, $2)`,
      [runId, reason.trim()]
    );
    await client.query(
      `UPDATE run SET status = 'rejected', updated_at = NOW() WHERE id = $1`,
      [runId]
    );
    await client.query(
      `INSERT INTO audit (run_id, table_name, record_id, action, new_value, actor)
       VALUES ($1, 'run', $2, 'reject', $3, $4)`,
      [runId, runId, JSON.stringify({ rejection_reason: reason.trim() }), approver]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getPdfKey(client: PoolClient, runId: string): Promise<string | null> {
  const result = await client.query("SELECT pdf_key FROM run WHERE id = $1 LIMIT 1", [runId]);
  if (!result.rowCount || result.rowCount === 0) return null;
  return result.rows[0].pdf_key ?? null;
}

export async function handleGetQueue(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  requireApprover(req);
  const client = await deps.pool.connect();
  try {
    const html = await renderQueue(client);
    htmlResponse(res, 200, html);
  } finally {
    client.release();
  }
}

export async function handleGetQueueRun(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  requireApprover(req);
  const match = req.url?.match(/^\/queue\/([0-9a-f-]+)$/);
  if (!match) {
    jsonResponse(res, 404, { error: "not found" });
    return;
  }
  const runId = match[1];
  const client = await deps.pool.connect();
  try {
    const html = await renderRunDetail(client, runId);
    if (html === null) {
      jsonResponse(res, 404, { error: "run not found" });
      return;
    }
    htmlResponse(res, 200, html);
  } finally {
    client.release();
  }
}

export async function handleApprove(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  const approver = requireApprover(req);
  const match = req.url?.match(/^\/queue\/([0-9a-f-]+)\/approve$/);
  if (!match) {
    jsonResponse(res, 404, { error: "not found" });
    return;
  }
  const runId = match[1];
  const body = await readBody(req);
  let payload: { edits?: unknown[] };
  try {
    payload = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: "invalid JSON body" });
    return;
  }
  const edits = parseEdits(payload.edits);
  const result = await approveRun(runId, approver, edits, deps);
  jsonResponse(res, 200, result);
}

export async function handleReject(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  const approver = requireApprover(req);
  const match = req.url?.match(/^\/queue\/([0-9a-f-]+)\/reject$/);
  if (!match) {
    jsonResponse(res, 404, { error: "not found" });
    return;
  }
  const runId = match[1];
  const body = await readBody(req);
  let payload: { rejection_reason?: string };
  try {
    payload = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: "invalid JSON body" });
    return;
  }
  await rejectRun(runId, approver, payload.rejection_reason ?? "", deps);
  jsonResponse(res, 200, { status: "rejected" });
}

export async function handleGetPdf(
  req: IncomingMessage,
  res: ServerResponse,
  deps: Deps
): Promise<void> {
  requireApprover(req);
  const match = req.url?.match(/^\/queue\/([0-9a-f-]+)\/pdf$/);
  if (!match) {
    jsonResponse(res, 404, { error: "not found" });
    return;
  }
  const runId = match[1];
  const client = await deps.pool.connect();
  try {
    const key = await getPdfKey(client, runId);
    if (!key) {
      jsonResponse(res, 404, { error: "pdf not found" });
      return;
    }
    const bytes = await deps.store.get(key);
    res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${key.split("/").pop()}"` });
    res.end(bytes);
  } finally {
    client.release();
  }
}

function parseEdits(raw: unknown): PendingEdit[] {
  if (!Array.isArray(raw)) return [];
  const edits: PendingEdit[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const edit = item as Record<string, unknown>;
    if (
      (edit.target === "line" || edit.target === "prose") &&
      typeof edit.field_path === "string" &&
      typeof edit.new_value === "string"
    ) {
      edits.push({ target: edit.target, field_path: edit.field_path, new_value: edit.new_value });
    }
  }
  return edits;
}
