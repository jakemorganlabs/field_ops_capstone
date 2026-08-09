import type { BillOfMaterials, BomLine, LaborLine } from "./agents/estimator.js";
import type { ProposalDocument } from "./agents/writer.js";

export interface MissingAssumption {
  source: string;
  text: string;
}

function assumptionText(line: BomLine | LaborLine): string {
  if ("item" in line) {
    return line.note ? `${line.item}: ${line.note}` : line.item;
  }
  return line.note ? `${line.role}: ${line.note}` : line.role;
}

/**
 * Return every BOM assumption item that does not appear in the proposal
 * assumptions list. A match is accepted if the assumption text is a substring
 * of any proposal assumption entry.
 */
export function findMissingAssumptions(
  proposal: ProposalDocument,
  bom: BillOfMaterials
): MissingAssumption[] {
  const missing: MissingAssumption[] = [];
  const lowerAssumptions = proposal.assumptions.map((a) => a.toLowerCase());

  for (const line of bom.lines) {
    if (line.assumption !== true) continue;
    const text = assumptionText(line);
    const lowerText = text.toLowerCase();
    const found = lowerAssumptions.some((a) => a.includes(lowerText));
    if (!found) {
      missing.push({ source: line.item, text });
    }
  }

  if (bom.labor) {
    for (const line of bom.labor) {
      if (line.assumption !== true) continue;
      const text = assumptionText(line);
      const lowerText = text.toLowerCase();
      const found = lowerAssumptions.some((a) => a.includes(lowerText));
      if (!found) {
        missing.push({ source: line.role, text });
      }
    }
  }

  return missing;
}
