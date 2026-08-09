import { config } from "dotenv";
import { pathToFileURL } from "node:url";
import { createPool } from "../src/db.js";
import { runMigrations, cleanDatabase, seedCorpus } from "../evals/seed.js";

config();

const DATABASE_URL = process.env.DATABASE_URL ?? "";

async function main(): Promise<void> {
  if (!DATABASE_URL.includes("fieldops_eval")) {
    throw new Error("Refusing to seed: DATABASE_URL must contain 'fieldops_eval'");
  }

  const pool = createPool();
  await runMigrations(pool);
  await cleanDatabase(pool);
  await seedCorpus(pool);
  await pool.end();
  console.log(JSON.stringify({ event: "seed_complete" }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
