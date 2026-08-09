import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface Thresholds {
  recall_at_k: Record<string, number>;
  schema_validity: number;
  calculator_balance: number;
  grounding_integrity: number;
  judge: { min_average_per_dimension: number; max_variance: number };
  reviewer_recall: number;
  injection_obeyed: number;
  idempotent_ingest: string;
}

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
  const [resultsText, thresholdsText] = await Promise.all([
    readFile("evals/results.json", "utf-8"),
    readFile("evals/thresholds.json", "utf-8"),
  ]);
  const results = JSON.parse(resultsText) as ResultsFile;
  const thresholds = JSON.parse(thresholdsText) as Thresholds;

  const failures: string[] = [];

  for (const metric of results.retrieval) {
    const threshold = thresholds.recall_at_k[metric.intent] ?? 0.8;
    if (metric.recall < threshold) {
      failures.push(`retrieval ${metric.intent}: ${metric.recall.toFixed(2)} < ${threshold}`);
    }
  }

  if (results.structural.schema_validity < thresholds.schema_validity) {
    failures.push(`schema_validity: ${results.structural.schema_validity.toFixed(2)} < ${thresholds.schema_validity}`);
  }
  if (results.structural.calculator_balance < thresholds.calculator_balance) {
    failures.push(`calculator_balance: ${results.structural.calculator_balance.toFixed(2)} < ${thresholds.calculator_balance}`);
  }
  if (results.structural.grounding_integrity < thresholds.grounding_integrity) {
    failures.push(`grounding_integrity: ${results.structural.grounding_integrity.toFixed(2)} < ${thresholds.grounding_integrity}`);
  }

  for (const metric of results.semantic) {
    if (metric.average < thresholds.judge.min_average_per_dimension) {
      failures.push(`semantic ${metric.dimension}: ${metric.average.toFixed(2)} < ${thresholds.judge.min_average_per_dimension}`);
    }
  }

  if (results.reviewer.recall < thresholds.reviewer_recall) {
    failures.push(`reviewer_recall: ${results.reviewer.recall.toFixed(2)} < ${thresholds.reviewer_recall}`);
  }

  if (!results.injection.passed) {
    failures.push(`injection: ${results.injection.obeyed.toFixed(2)} > ${thresholds.injection_obeyed}`);
  }

  if (!results.ingest.passed) {
    failures.push(`idempotent_ingest: failed`);
  }

  if (failures.length > 0) {
    console.error("Eval gate FAILED:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log("Eval gate PASSED");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
