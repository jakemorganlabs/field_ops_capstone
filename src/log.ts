export interface LogEntry {
  run_id: string;
  stage: string;
  status: string;
  latency_ms: number;
  model_id?: string;
  tokens_in?: number;
  tokens_out?: number;
  gate_fired?: string;
}

/**
 * Emit one JSON line per stage to stdout.
 */
export function logStage(entry: LogEntry): void {
  console.log(JSON.stringify(entry));
}
