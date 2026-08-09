import { config } from "dotenv";
import { createPool } from "../src/db.js";

config();

const pool = createPool();

interface RunSeed {
  status: string;
  proposal: object;
  bom: object;
  total_cost: string;
  critique?: object;
}

const seeds: Record<string, RunSeed> = {
  happy: {
    status: "complete",
    proposal: {
      run_id: "__RUN_ID__",
      bom_id: "__RUN_ID__",
      summary: "Happy path proposal",
      terms: "Net 30",
      valid_until: "2026-12-31",
      assumptions: [],
      code_claims: [],
    },
    bom: {
      run_id: "__RUN_ID__",
      lines: [
        {
          item: "Cat6A cable",
          quantity: "1000",
          unit_cost: "0.25",
          unit: "ft",
          citation: { chunk_id: "00000000-0000-0000-0000-000000000001", snippet: "Cat6A cable $0.25/ft" },
        },
      ],
      labor: [],
    },
    total_cost: "250.00",
  },
  edit: {
    status: "needs_review",
    proposal: {
      run_id: "__RUN_ID__",
      bom_id: "__RUN_ID__",
      summary: "Edit test proposal",
      assumptions: [],
      code_claims: [],
    },
    bom: {
      run_id: "__RUN_ID__",
      lines: [
        {
          item: "Switch",
          quantity: "1",
          unit_cost: "500.00",
          citation: { chunk_id: "00000000-0000-0000-0000-000000000002", snippet: "Switch $500" },
        },
      ],
      labor: [],
    },
    total_cost: "500.00",
  },
  escalated: {
    status: "needs_review",
    proposal: {
      run_id: "__RUN_ID__",
      bom_id: "__RUN_ID__",
      summary: "Escalated proposal",
      assumptions: [],
      code_claims: [],
    },
    bom: {
      run_id: "__RUN_ID__",
      lines: [
        {
          item: "Router",
          quantity: "1",
          unit_cost: "1000.00",
          assumption: true,
          note: "price not found",
        },
      ],
      labor: [],
    },
    total_cost: "1000.00",
    critique: {
      issues: [
        {
          type: "pricing_anomaly",
          severity: "warning",
          target_agent: "estimator",
          description: "Router price seems high",
          evidence_chunk_id: "00000000-0000-0000-0000-000000000000",
        },
      ],
    },
  },
  reject: {
    status: "needs_review",
    proposal: {
      run_id: "__RUN_ID__",
      bom_id: "__RUN_ID__",
      summary: "Reject proposal",
      assumptions: [],
      code_claims: [],
    },
    bom: {
      run_id: "__RUN_ID__",
      lines: [
        {
          item: "Firewall",
          quantity: "1",
          unit_cost: "2000.00",
          assumption: true,
          note: "price not found",
        },
      ],
      labor: [],
    },
    total_cost: "2000.00",
  },
};

async function seed(): Promise<Record<string, string>> {
  const client = await pool.connect();
  const ids: Record<string, string> = {};
  try {
    await client.query("BEGIN");
    for (const [key, seed] of Object.entries(seeds)) {
      const hash = `gate-smoke-${key}-${Date.now()}`;
      const runResult = await client.query(
        `INSERT INTO run (intake_hash, status, proposal, bom, total_cost, critique)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [hash, seed.status, "{}", "{}", seed.total_cost, seed.critique ? JSON.stringify(seed.critique) : null]
      );
      const runId = runResult.rows[0].id as string;
      const proposal = JSON.parse(JSON.stringify(seed.proposal).replace(/__RUN_ID__/g, runId));
      const bom = JSON.parse(JSON.stringify(seed.bom).replace(/__RUN_ID__/g, runId));
      await client.query(
        `UPDATE run SET proposal = $1, bom = $2 WHERE id = $3`,
        [JSON.stringify(proposal), JSON.stringify(bom), runId]
      );
      ids[key] = runId;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return ids;
}

async function main(): Promise<void> {
  const ids = await seed();
  const outputPath = process.argv[2];
  const json = JSON.stringify(ids);
  if (outputPath) {
    await import("node:fs/promises").then((fs) => fs.writeFile(outputPath, json));
  }
  console.log(json);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
