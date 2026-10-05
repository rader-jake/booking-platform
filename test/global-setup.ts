import { runMigrations } from "../src/db/migrate.js";
import { TEST_DATABASE_URL } from "./db-url.js";

export default async function setup() {
  const host = new URL(TEST_DATABASE_URL).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Tests only run against a local database (got host "${host}")`);
  }
  try {
    await runMigrations(TEST_DATABASE_URL);
  } catch (err) {
    throw new Error(`Could not migrate the test database. Is it running? Try \`npm run test:db\`.\n${String(err)}`);
  }
}
