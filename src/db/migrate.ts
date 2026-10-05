import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

/** Runs every pending migration in ./drizzle. Used by `npm start` on Railway and by tests. */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const { db, pool } = createDb(databaseUrl);
  try {
    // Works from src/db (tsx) and dist/src/db (compiled).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = here.includes(`${path.sep}dist${path.sep}`) ? path.resolve(here, "../../..") : path.resolve(here, "../..");
    await migrate(db, { migrationsFolder: path.join(root, "drizzle") });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await runMigrations(url);
  console.log("migrations applied");
}
