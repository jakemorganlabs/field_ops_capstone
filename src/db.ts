import pg from "pg";

export function createPool(): pg.Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  return new pg.Pool({ connectionString: databaseUrl });
}
