import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface ResultsFile {
  commit_hash: string;
  timestamp: string;
  counts: Record<string, number>;
  retrieval: Array<{ intent: string; recall: number; passed: boolean }>;
  structural: { schema_validity: number; calculator_balance: number; grounding_integrity: number };
  semantic: Array<{ dimension: string; average: number; variance: number; high_variance_cases: number; passed: boolean }>;
  reviewer: { recall: number; passed: boolean };
  escalation: { route_accuracy: number; passed: boolean };
  injection: { obeyed: number; passed: boolean };
  ingest: { exact: number; passed: boolean };
  samples: Array<{ scenario: string; run_id: string; status: string; route: string; errors: string[] }>;
}

async function main(): Promise<void> {
  const text = await readFile("evals/results.json", "utf-8");
  const results = JSON.parse(text) as ResultsFile;

  const lines: string[] = [];
  lines.push("# Eval Report");
  lines.push("");
  lines.push(`- Commit: ${results.commit_hash}`);
  lines.push(`- Timestamp: ${results.timestamp}`);
  lines.push("");

  lines.push("## Counts");
  lines.push("");
  lines.push("| Scenario | Count |");
  lines.push("| --- | --- |");
  for (const [scenario, count] of Object.entries(results.counts)) {
    lines.push(`| ${scenario} | ${count} |`);
  }
  lines.push("");

  lines.push("## Retrieval Recall at k");
  lines.push("");
  lines.push("| Intent | Recall | Threshold | Status |");
  lines.push("| --- | --- | --- | --- |");
  for (const m of results.retrieval) {
    lines.push(`| ${m.intent} | ${m.recall.toFixed(2)} | 0.80 | ${m.passed ? "PASS" : "FAIL"} |`);
  }
  lines.push("");

  lines.push("## Structural Metrics");
  lines.push("");
  lines.push("| Metric | Value | Threshold | Status |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| Schema validity | ${results.structural.schema_validity.toFixed(2)} | 1.00 | ${results.structural.schema_validity === 1 ? "PASS" : "FAIL"} |`);
  lines.push(`| Calculator balance | ${results.structural.calculator_balance.toFixed(2)} | 1.00 | ${results.structural.calculator_balance === 1 ? "PASS" : "FAIL"} |`);
  lines.push(`| Grounding integrity | ${results.structural.grounding_integrity.toFixed(2)} | 1.00 | ${results.structural.grounding_integrity === 1 ? "PASS" : "FAIL"} |`);
  lines.push("");

  lines.push("## Semantic Judge Scores");
  lines.push("");
  lines.push("| Dimension | Average | Threshold | High Variance Cases | Status |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const m of results.semantic) {
    lines.push(`| ${m.dimension} | ${m.average.toFixed(2)} | 3.50 | ${m.high_variance_cases} | ${m.passed ? "PASS" : "FAIL"} |`);
  }
  lines.push("");

  lines.push("## Reviewer and Escalation");
  lines.push("");
  lines.push("| Metric | Value | Threshold | Status |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| Reviewer recall | ${results.reviewer.recall.toFixed(2)} | 0.85 | ${results.reviewer.passed ? "PASS" : "FAIL"} |`);
  lines.push(`| Route accuracy | ${results.escalation.route_accuracy.toFixed(2)} | - | - |`);
  lines.push("");

  lines.push("## Injection and Idempotency");
  lines.push("");
  lines.push("| Metric | Value | Threshold | Status |");
  lines.push("| --- | --- | --- | --- |");
  lines.push(`| Injection obeyed | ${results.injection.obeyed.toFixed(2)} | <= 0 | ${results.injection.passed ? "PASS" : "FAIL"} |`);
  lines.push(`| Idempotent ingest exact | ${results.ingest.exact.toFixed(2)} | exact | ${results.ingest.passed ? "PASS" : "FAIL"} |`);
  lines.push("");

  lines.push("## Misses");
  lines.push("");
  const misses = results.samples.filter((s) => s.errors.length > 0 || s.status === "failed" || s.status === "needs_review");
  if (misses.length === 0) {
    lines.push("No misses recorded.");
  } else {
    lines.push("| Scenario | Run ID | Status | Errors |");
    lines.push("| --- | --- | --- | --- |");
    for (const m of misses) {
      lines.push(`| ${m.scenario} | ${m.run_id} | ${m.status} | ${m.errors.join("; ") || "-"} |`);
    }
  }
  lines.push("");

  lines.push("## Aggregate");
  lines.push("");
  const allPassed =
    results.retrieval.every((m) => m.passed) &&
    results.structural.schema_validity === 1 &&
    results.structural.calculator_balance === 1 &&
    results.structural.grounding_integrity === 1 &&
    results.semantic.every((m) => m.passed) &&
    results.reviewer.passed &&
    results.injection.passed &&
    results.ingest.passed;
  lines.push(`Aggregate: ${allPassed ? "PASS" : "FAIL"}`);
  lines.push("");

  const report = lines.join("\n");
  await writeFile("docs/sample_eval_report.md", report);
  console.log(report);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
