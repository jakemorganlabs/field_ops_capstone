import PDFDocument from "pdfkit";
import { Decimal } from "decimal.js";
import type { BillOfMaterials, BomLine, ComputedTotals, LaborLine } from "./agents/estimator.js";
import type { ProposalDocument } from "./agents/writer.js";

export interface PdfInput {
  run_id: string;
  proposal: ProposalDocument;
  bom: BillOfMaterials;
  totals: ComputedTotals;
}

export async function renderProposalPdf(input: PdfInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({ margin: 50 });

    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const proposal = input.proposal;
    const bom = input.bom;
    const totals = input.totals;

    doc.fontSize(20).text("Proposal", { align: "center" });
    doc.moveDown();

    doc.fontSize(12).text(`Run: ${input.run_id}`);
    doc.moveDown(0.5);

    if (proposal.summary) {
      doc.fontSize(14).text("Summary");
      doc.fontSize(11).text(proposal.summary);
      doc.moveDown();
    }

    if (proposal.terms) {
      doc.fontSize(14).text("Terms");
      doc.fontSize(11).text(proposal.terms);
      doc.moveDown();
    }

    if (proposal.valid_until) {
      doc.fontSize(11).text(`Valid until: ${proposal.valid_until}`);
      doc.moveDown();
    }

    doc.fontSize(14).text("Bill of Materials");
    doc.moveDown(0.5);

    const footnotes: { index: number; text: string }[] = [];
    let footnoteIndex = 1;

    function renderLineTable(lines: BomLine[]): void {
      if (lines.length === 0) return;
      const tableTop = doc.y;
      const colX = [50, 220, 300, 380, 460];
      doc.fontSize(10).text("Item", colX[0], tableTop);
      doc.text("Qty", colX[1], tableTop);
      doc.text("Unit Cost", colX[2], tableTop);
      doc.text("Ext", colX[3], tableTop);
      doc.text("Note", colX[4], tableTop);
      doc.moveDown();

      for (const line of lines) {
        const y = doc.y;
        const ext = new Decimal(line.quantity).times(new Decimal(line.unit_cost)).toDecimalPlaces(2).toFixed(2);
        const note = line.assumption ? "assumption" : "";
        doc.text(line.item, colX[0], y, { width: 160 });
        doc.text(line.quantity, colX[1], y);
        doc.text(line.unit_cost, colX[2], y);
        doc.text(ext, colX[3], y);
        doc.text(note, colX[4], y);

        if (line.citation) {
          footnotes.push({ index: footnoteIndex, text: `[${line.citation.chunk_id}] ${line.citation.snippet}` });
          doc.text(`[${footnoteIndex}]`, colX[4] + 50, y);
          footnoteIndex += 1;
        }
        doc.moveDown();
      }
    }

    renderLineTable(bom.lines);

    if (bom.labor && bom.labor.length > 0) {
      doc.moveDown();
      doc.fontSize(14).text("Labor");
      doc.moveDown(0.5);
      const tableTop = doc.y;
      const colX = [50, 220, 300, 380, 460];
      doc.fontSize(10).text("Role", colX[0], tableTop);
      doc.text("Hours", colX[1], tableTop);
      doc.text("Rate Key", colX[2], tableTop);
      doc.text("Cost", colX[3], tableTop);
      doc.text("Note", colX[4], tableTop);
      doc.moveDown();

      for (const line of bom.labor) {
        const y = doc.y;
        const note = line.assumption ? "assumption" : "";
        doc.text(line.role, colX[0], y, { width: 160 });
        doc.text(line.hours, colX[1], y);
        doc.text(line.rate_key, colX[2], y);
        doc.text("-", colX[3], y);
        doc.text(note, colX[4], y);

        if (line.citation) {
          footnotes.push({ index: footnoteIndex, text: `[${line.citation.chunk_id}] ${line.citation.snippet}` });
          doc.text(`[${footnoteIndex}]`, colX[4] + 50, y);
          footnoteIndex += 1;
        }
        doc.moveDown();
      }
    }

    if (proposal.assumptions && proposal.assumptions.length > 0) {
      doc.moveDown();
      doc.fontSize(14).text("Assumptions");
      doc.fontSize(11);
      for (const assumption of proposal.assumptions) {
        doc.text(`- ${assumption}`);
      }
      doc.moveDown();
    }

    if (proposal.code_claims && proposal.code_claims.length > 0) {
      doc.moveDown();
      doc.fontSize(14).text("Code Claims");
      doc.fontSize(11);
      for (const claim of proposal.code_claims) {
        doc.text(`- ${claim.claim}`);
      }
      doc.moveDown();
    }

    doc.moveDown();
    doc.fontSize(14).text("Totals");
    doc.fontSize(11);
    doc.text(`Materials: ${totals.materials}`);
    doc.text(`Labor: ${totals.labor}`);
    doc.text(`Tax: ${totals.tax}`);
    doc.text(`Total: ${totals.total}`);

    if (footnotes.length > 0) {
      doc.addPage();
      doc.fontSize(14).text("Citations");
      doc.moveDown();
      doc.fontSize(10);
      for (const footnote of footnotes) {
        doc.text(`${footnote.index}. ${footnote.text}`);
        doc.moveDown(0.3);
      }
    }

    doc.end();
  });
}
