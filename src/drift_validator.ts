import { Decimal } from "decimal.js";
import type { BillOfMaterials, BomLine, ComputedTotals } from "./agents/estimator.js";
import type { ProjectSpec } from "./qualification.js";

export interface DriftFinding {
  field: string;
  expected: string;
  found: string;
}

const NUMBER_RE = /\$\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?/g;

function normalizeNumberToken(token: string): Decimal {
  const cleaned = token.replace(/\$/g, "").replace(/,/g, "").replace(/\s+/g, "");
  return new Decimal(cleaned);
}

function extendedCost(line: BomLine): string {
  const q = new Decimal(line.quantity);
  const c = new Decimal(line.unit_cost);
  return q.mul(c).toDecimalPlaces(2).toFixed(2);
}

function extractNumbersFromText(text: string): Decimal[] {
  const matches = text.match(NUMBER_RE) ?? [];
  const result: Decimal[] = [];
  for (const token of matches) {
    try {
      result.push(normalizeNumberToken(token));
    } catch {
      // Ignore tokens that cannot be parsed as numbers.
    }
  }
  return result;
}

function buildAllowedSet(bom: BillOfMaterials, totals: ComputedTotals, spec: ProjectSpec): Decimal[] {
  const allowed: Decimal[] = [];

  for (const line of bom.lines) {
    allowed.push(new Decimal(line.quantity));
    allowed.push(new Decimal(line.unit_cost));
    allowed.push(new Decimal(extendedCost(line)));
    allowed.push(...extractNumbersFromText(line.item));
    if (line.note) allowed.push(...extractNumbersFromText(line.note));
  }

  if (bom.labor) {
    for (const line of bom.labor) {
      allowed.push(new Decimal(line.hours));
      allowed.push(...extractNumbersFromText(line.role));
      if (line.note) allowed.push(...extractNumbersFromText(line.note));
    }
  }

  allowed.push(new Decimal(totals.materials));
  allowed.push(new Decimal(totals.labor));
  allowed.push(new Decimal(totals.tax));
  allowed.push(new Decimal(totals.total));

  const specFields = [
    spec.project_name,
    spec.client_name,
    spec.location,
    spec.region,
    spec.scope,
    spec.notes,
    spec.raw_text,
    ...(spec.materials ?? []),
    ...(spec.labor ?? []),
    ...(spec.constraints ?? []),
  ];

  for (const field of specFields) {
    if (typeof field !== "string") continue;
    const matches = field.match(NUMBER_RE);
    if (!matches) continue;
    for (const token of matches) {
      try {
        allowed.push(normalizeNumberToken(token));
      } catch {
        // Ignore tokens that cannot be parsed as numbers.
      }
    }
  }

  return allowed;
}

function extractNumbers(text: string): Array<{ token: string; value: Decimal }> {
  const matches = text.match(NUMBER_RE) ?? [];
  const result: Array<{ token: string; value: Decimal }> = [];
  for (const token of matches) {
    try {
      result.push({ token, value: normalizeNumberToken(token) });
    } catch {
      // Ignore malformed tokens.
    }
  }
  return result;
}

function isAllowed(value: Decimal, allowed: Decimal[]): boolean {
  return allowed.some((a) => a.equals(value));
}

function scanField(fieldPath: string, text: string, allowed: Decimal[], findings: DriftFinding[]): void {
  for (const { token, value } of extractNumbers(text)) {
    if (!isAllowed(value, allowed)) {
      findings.push({ field: fieldPath, expected: "allowed value", found: token });
    }
  }
}

interface ProposalLineItem {
  description: string;
  amount: string;
  quantity?: string;
  unit_price?: string;
}

interface CodeClaim {
  claim: string;
  chunk_id: string;
  snippet: string;
}

interface ProposalDocument {
  run_id: string;
  bom_id: string;
  summary: string;
  line_items?: ProposalLineItem[];
  labor_total?: string;
  material_subtotal?: string;
  tax_rate?: string;
  tax_amount?: string;
  total?: string;
  terms?: string;
  valid_until?: string;
  assumptions: string[];
  code_claims: CodeClaim[];
}

function scanLineItem(
  index: number,
  item: ProposalLineItem,
  allowed: Decimal[],
  findings: DriftFinding[]
): void {
  const prefix = `line_items[${index}]`;
  scanField(`${prefix}.description`, item.description, allowed, findings);
  scanField(`${prefix}.amount`, item.amount, allowed, findings);
  if (item.quantity !== undefined) {
    scanField(`${prefix}.quantity`, item.quantity, allowed, findings);
  }
  if (item.unit_price !== undefined) {
    scanField(`${prefix}.unit_price`, item.unit_price, allowed, findings);
  }
}

/**
 * Find every number token in the proposal prose fields that is not present in
 * the allowed set derived from the BOM, computed totals, and spec. Also report
 * a changed total. Exact match only, zero tolerance. Numbers inside code claim
 * snippets are not scanned.
 */
export function findNumericalDrift(
  proposal: ProposalDocument,
  bom: BillOfMaterials,
  totals: ComputedTotals,
  spec: ProjectSpec
): DriftFinding[] {
  const allowed = buildAllowedSet(bom, totals, spec);
  const findings: DriftFinding[] = [];

  if (proposal.total !== undefined && proposal.total !== totals.total) {
    findings.push({ field: "total", expected: totals.total, found: proposal.total });
  }

  scanField("summary", proposal.summary, allowed, findings);

  if (proposal.line_items) {
    for (let i = 0; i < proposal.line_items.length; i += 1) {
      scanLineItem(i, proposal.line_items[i], allowed, findings);
    }
  }

  if (proposal.terms !== undefined) {
    scanField("terms", proposal.terms, allowed, findings);
  }

  for (let i = 0; i < proposal.assumptions.length; i += 1) {
    scanField(`assumptions[${i}]`, proposal.assumptions[i], allowed, findings);
  }

  for (let i = 0; i < proposal.code_claims.length; i += 1) {
    const claim = proposal.code_claims[i];
    scanField(`code_claims[${i}].claim`, claim.claim, allowed, findings);
    // Snippets are intentionally exempt from drift scanning.
  }

  return findings;
}
