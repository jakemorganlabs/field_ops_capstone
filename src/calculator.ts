import { Decimal } from "decimal.js";

export interface BomLine {
  item: string;
  quantity: string | number;
  unit_cost: string | number;
}

export interface LaborLine {
  role: string;
  hours: string | number;
  rate_key: string;
}

const CENTS = new Decimal("0.01");

export function extendedCost(qty: string | number, unitCost: string | number): string {
  const q = new Decimal(qty);
  const c = new Decimal(unitCost);
  return q.mul(c).toDecimalPlaces(2).toFixed(2);
}

export function materialSubtotal(lines: BomLine[]): string {
  const total = lines.reduce((sum, line) => {
    return sum.plus(new Decimal(extendedCost(line.quantity, line.unit_cost)));
  }, new Decimal("0"));
  return total.toDecimalPlaces(2).toFixed(2);
}

export function laborTotal(labor: LaborLine[], rateMap: Record<string, string>): string {
  const total = labor.reduce((sum, line) => {
    const rate = rateMap[line.rate_key];
    if (rate === undefined) {
      throw new Error(`Missing rate for ${line.rate_key}`);
    }
    return sum.plus(new Decimal(extendedCost(line.hours, rate)));
  }, new Decimal("0"));
  return total.toDecimalPlaces(2).toFixed(2);
}

export function proposalTotal(subtotal: string, labor: string, taxRate: string): string {
  const base = new Decimal(subtotal).plus(new Decimal(labor));
  const tax = base.mul(new Decimal(taxRate));
  return base.plus(tax).toDecimalPlaces(2).toFixed(2);
}
