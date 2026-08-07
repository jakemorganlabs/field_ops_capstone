import { writeFile } from "node:fs/promises";

function makePdf(text) {
  const body = text.replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/\\/g, "\\\\");
  const obj1 = "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj";
  const obj2 = "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj";
  const obj3 = `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj`;
  const stream = `BT\n/F1 12 Tf\n72 700 Td\n(${body}) Tj\nET`;
  const obj4 = `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj`;
  const obj5 = "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj";

  const objects = [obj1, obj2, obj3, obj4, obj5];
  const xrefOffsets = [];
  let offset = 0;
  const header = "%PDF-1.4\n";
  offset = header.length;
  for (const obj of objects) {
    xrefOffsets.push(offset);
    offset += obj.length + 1;
  }
  const xrefStart = offset;
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xrefOffsets
    .map((o) => String(o).padStart(10, "0") + " 00000 n \n")
    .join("")}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return header + objects.join("\n") + "\n" + xref + "\n" + trailer;
}

const text = "This is a synthetic PDF document for ingestion pipeline testing.";
const pdf = makePdf(text);
await writeFile("fixtures/synthetic_corpus/synthetic.pdf", pdf);
console.log("fixtures/synthetic_corpus/synthetic.pdf created");
