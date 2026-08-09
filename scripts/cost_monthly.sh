#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

DATABASE_URL="${DATABASE_URL:-postgresql://fieldops:fieldops@127.0.0.1:5432/fieldops}"
export DATABASE_URL

node --experimental-strip-types --import ./scripts/ts-register.mjs - <<'NODE'
import { readFile } from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const pricingText = await readFile("config/pricing.json", "utf-8");
  const pricing = JSON.parse(pricingText);

  const pricingDate = new Date(pricing.date);
  const ageDays = Math.floor((Date.now() - pricingDate.getTime()) / (1000 * 60 * 60 * 24));
  if (ageDays > 90) {
    console.error(`WARNING: pricing.json is ${ageDays} days old`);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const client = await pool.connect();
  let rows;
  try {
    const result = await client.query(
      `SELECT
         action,
         SUM(tokens_in) AS tokens_in,
         SUM(tokens_out) AS tokens_out
       FROM audit
       WHERE created_at >= NOW() - INTERVAL '30 days'
         AND tokens_in IS NOT NULL
       GROUP BY action
       ORDER BY action`
    );
    rows = result.rows;
  } finally {
    client.release();
    await pool.end();
  }

  const generationRate = pricing.models["google/gemma-4-26B-A4B-it"] || { input_per_1m: 0, output_per_1m: 0 };
  let total = 0;
  const lines = [];
  for (const row of rows) {
    const tokensIn = Number(row.tokens_in) || 0;
    const tokensOut = Number(row.tokens_out) || 0;
    const inputCost = (tokensIn / 1_000_000) * generationRate.input_per_1m;
    const outputCost = (tokensOut / 1_000_000) * generationRate.output_per_1m;
    const cost = inputCost + outputCost;
    total += cost;
    lines.push({
      action: row.action,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: cost.toFixed(6),
    });
  }

  console.log(JSON.stringify({ pricing_date: pricing.date, age_days: ageDays, total_usd: total.toFixed(6), breakdown: lines }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
