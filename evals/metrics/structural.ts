import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Decimal } from "decimal.js";
import type { EvalSample } from "./types.js";

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);

let specSchema: object | null = null;
let bomSchema: object | null = null;
let proposalSchema: object | null = null;

async function loadSchemas(): Promise<void> {
  if (specSchema && bomSchema && proposalSchema) return;
  const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
  const [specText, bomText, proposalText] = await Promise.all([
    readFile(join(base, "project_spec.json"), "utf-8"),
    readFile(join(base, "bom.json"), "utf-8"),
    readFile(join(base, "proposal.json"), "utf-8"),
  ]);
  specSchema = JSON.parse(specText);
  bomSchema = JSON.parse(bomText);
  proposalSchema = JSON.parse(proposalText);
}

export interface StructuralMetrics {
  schema_validity: number;
  calculator_balance: number;
  grounding_integrity: number;
}

export async function scoreStructural(samples: EvalSample[]): Promise<StructuralMetrics> {
  await loadSchemas();
  const validateSpec = ajv.compile(specSchema!);
  const validateBom = ajv.compile(bomSchema!);
  const validateProposal = ajv.compile(proposalSchema!);

  let schemaOk = 0;
  let balanceOk = 0;
  let groundingOk = 0;
  let total = 0;

  for (const sample of samples) {
    if (sample.errors.length > 0) continue;
    total += 1;

    const specOk = sample.spec ? validateSpec(sample.spec) : false;
    const bomOk = sample.bom ? validateBom(sample.bom) : false;
    const proposalOk = sample.proposal ? validateProposal(sample.proposal) : false;
    if (specOk && bomOk && proposalOk) {
      schemaOk += 1;
    }

    if (sample.bom && sample.totals) {
      if (await checkBalance(sample.bom, sample.totals)) {
        balanceOk += 1;
      }
    }

    if (sample.bom && checkGrounding(sample.bom)) {
      groundingOk += 1;
    }
  }

  return {
    schema_validity: total === 0 ? 1 : schemaOk / total,
    calculator_balance: total === 0 ? 1 : balanceOk / total,
    grounding_integrity: total === 0 ? 1 : groundingOk / total,
  };
}

async function loadRateConfig(): Promise<{ rateMap: Record<string, string>; taxRate: string }> {
  const base = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "config");
  const [ratesText, taxText] = await Promise.all([
    readFile(join(base, "labor_rates.json"), "utf-8"),
    readFile(join(base, "tax.json"), "utf-8"),
  ]);
  const rateMap = JSON.parse(ratesText) as Record<string, string>;
  const taxRate = String((JSON.parse(taxText) as { rate: string }).rate);
  return { rateMap, taxRate };
}

async function checkBalance(bom: NonNullable<EvalSample["bom"]>, totals: NonNullable<EvalSample["totals"]>): Promise<boolean> {
  try {
    const { rateMap, taxRate } = await loadRateConfig();
    const materials = materialSubtotal(bom.lines);
    const labor = bom.labor ? laborTotal(bom.labor, rateMap) : "0.00";
    const total = proposalTotal(materials, labor, taxRate);
    return total === totals.total;
  } catch {
    return false;
  }
}

function materialSubtotal(lines: { item: string; quantity: string | number; unit_cost: string | number }[]): string {
  const total = lines.reduce((sum, line) => {
    const q = new Decimal(line.quantity);
    const c = new Decimal(line.unit_cost);
    return sum.plus(q.mul(c).toDecimalPlaces(2));
  }, new Decimal("0"));
  return total.toDecimalPlaces(2).toFixed(2);
}

function laborTotal(labor: { role: string; hours: string | number; rate_key: string }[], rateMap: Record<string, string>): string {
  const total = labor.reduce((sum, line) => {
    const rate = rateMap[line.rate_key];
    if (rate === undefined) {
      throw new Error(`Missing rate for ${line.rate_key}`);
    }
    const h = new Decimal(line.hours);
    const r = new Decimal(rate);
    return sum.plus(h.mul(r).toDecimalPlaces(2));
  }, new Decimal("0"));
  return total.toDecimalPlaces(2).toFixed(2);
}

function proposalTotal(materials: string, labor: string, taxRate: string): string {
  const base = new Decimal(materials).plus(new Decimal(labor));
  const tax = base.mul(new Decimal(taxRate)).toDecimalPlaces(2);
  return base.plus(tax).toDecimalPlaces(2).toFixed(2);
}

function checkGrounding(bom: NonNullable<EvalSample["bom"]>): boolean {
  for (const line of bom.lines) {
    if (!line.assumption && !line.citation) {
      return false;
    }
  }
  if (bom.labor) {
    for (const line of bom.labor) {
      if (!line.assumption && !line.citation) {
        return false;
      }
    }
  }
  return true;
}
