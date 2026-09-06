import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RESULTS_PATH, type ResultsFile } from "./gate.js";

export type BadgeState = { label: string; value: string; passed: boolean };

/**
 * A smoke run only measured retrieval, so the badge says "smoke" and reports
 * retrieval alone. A full run must carry every section before it can be
 * called passing; a missing section is a failing badge.
 */
export function badgeState(results: ResultsFile): BadgeState {
  const retrievalPassed = Array.isArray(results.retrieval) && results.retrieval.length > 0 && results.retrieval.every((m) => m.passed);

  if (results.mode === "smoke") {
    return { label: "smoke", value: retrievalPassed ? "retrieval ok" : "retrieval fail", passed: retrievalPassed };
  }

  const s = results.structural;
  const passed =
    retrievalPassed &&
    s !== undefined &&
    s.schema_validity === 1 &&
    s.calculator_balance === 1 &&
    s.grounding_integrity === 1 &&
    Array.isArray(results.semantic) &&
    results.semantic.length > 0 &&
    results.semantic.every((m) => m.passed) &&
    results.reviewer?.passed === true &&
    results.escalation?.passed === true &&
    results.injection?.passed === true &&
    results.ingest?.passed === true &&
    (results.refusal === undefined || results.refusal.passed === true);

  return { label: "evals", value: passed ? "passing" : "failing", passed };
}

function buildBadge(state: BadgeState): string {
  const color = state.passed ? "44cc11" : "e05d44";
  const labelWidth = 10 + state.label.length * 7;
  const valueWidth = 10 + state.value.length * 7;
  const width = labelWidth + valueWidth;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${state.label}: ${state.value}">
  <title>${state.label}: ${state.value}</title>
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
    <text x="${labelWidth / 2}" y="14">${state.label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${state.value}</text>
  </g>
</svg>`;
}

async function main(): Promise<void> {
  const text = await readFile(RESULTS_PATH, "utf-8");
  const results = JSON.parse(text) as ResultsFile;
  const state = badgeState(results);

  const svg = buildBadge(state);
  await writeFile("docs/eval_badge.svg", svg);
  console.log(JSON.stringify({ event: "badge_written", path: "docs/eval_badge.svg", results_file: RESULTS_PATH, ...state }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
