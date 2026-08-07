import "dotenv/config";
import { readdir, stat, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { fsObjectStore } from "../src/objectstore.js";
import { ingestFiles } from "../src/ingest/ingest.js";
import type { EmbedCfg } from "../src/ingest/embedder.js";

const { Pool } = pg;

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1] ?? "";
      if (!value.startsWith("--")) {
        args[key] = value;
        i += 1;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(root, entry);
    const s = await stat(full);
    if (s.isFile()) {
      files.push(full);
    }
  }
  return files;
}

async function main() {
  const args = parseArgs(process.argv);
  const docType = args["doc-type"];
  const pathArg = args.path;
  const region = args.region;
  const date = args.date;
  const source = args.source ?? "synthetic_corpus";

  if (!docType) {
    console.error("--doc-type is required");
    process.exit(1);
  }
  if (!pathArg) {
    console.error("--path is required");
    process.exit(1);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const embedCfg: EmbedCfg = {
    baseUrl: process.env.EMBEDDING_BASE_URL!,
    modelId: process.env.EMBEDDING_MODEL_ID!,
    dimensions: Number(process.env.EMBEDDING_DIMENSIONS || "1536"),
    apiKey: process.env.DEEPINFRA_API_KEY!,
  };

  if (!embedCfg.baseUrl || !embedCfg.modelId || !embedCfg.apiKey) {
    console.error("EMBEDDING_BASE_URL, EMBEDDING_MODEL_ID, and DEEPINFRA_API_KEY are required");
    process.exit(1);
  }

  const objectStoreDir = process.env.OBJECT_STORE_DIR || resolve("objects");
  await mkdir(objectStoreDir, { recursive: true });

  const pool = new Pool({ connectionString: databaseUrl });
  const store = fsObjectStore(objectStoreDir);

  const files = await listFiles(resolve(pathArg));
  const results = await ingestFiles(files, {
    docType,
    source,
    region,
    date,
    pool,
    store,
    embedCfg,
  });

  console.log(JSON.stringify(results, null, 2));
  await pool.end();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
