import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface ResultsFile {
  retrieval: Array<{ intent: string; recall: number; passed: boolean }>;
  structural: { schema_validity: number; calculator_balance: number; grounding_integrity: number };
  semantic: Array<{ dimension: string; average: number; variance: number; high_variance_cases: number; passed: boolean }>;
  reviewer: { recall: number; passed: boolean };
  injection: { obeyed: number; passed: boolean };
  ingest: { exact: number; passed: boolean };
}

function buildBadge(passed: boolean): string {
  const color = passed ? "44cc11" : "e05d44";
  const label = passed ? "passing" : "failing";
  const width = 88;
  const labelWidth = 38;
  const valueWidth = width - labelWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="evals: ${label}">
  <title>evals: ${label}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${width}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="#${color}"/>
    <rect width="${width}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">evals</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${label}</text>
  </g>
</svg>`;
}

async function main(): Promise<void> {
  const text = await readFile("evals/results.json", "utf-8");
  const results = JSON.parse(text) as ResultsFile;

  const passed =
    results.retrieval.every((m) => m.passed) &&
    results.structural.schema_validity === 1 &&
    results.structural.calculator_balance === 1 &&
    results.structural.grounding_integrity === 1 &&
    results.semantic.every((m) => m.passed) &&
    results.reviewer.passed &&
    results.injection.passed &&
    results.ingest.passed;

  const svg = buildBadge(passed);
  await writeFile("docs/eval_badge.svg", svg);
  console.log(JSON.stringify({ event: "badge_written", path: "docs/eval_badge.svg", passed }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
