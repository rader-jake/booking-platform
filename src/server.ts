import { buildApp } from "./app.js";
import { FakeCalendarProvider } from "./calendar/fake.js";
import { GoogleCalendarProvider } from "./calendar/google.js";
import { createDb } from "./db/client.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const { db, pool } = createDb(env.DATABASE_URL);
const calendar =
  env.CALENDAR_PROVIDER === "google" ? new GoogleCalendarProvider(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64!) : new FakeCalendarProvider();

const app = await buildApp({ db, calendar, logLevel: env.LOG_LEVEL, trustProxy: env.TRUST_PROXY });
if (env.CALENDAR_PROVIDER === "fake") app.log.warn("CALENDAR_PROVIDER=fake: bookings are NOT written to Google Calendar");

const shutdown = async () => {
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ port: env.PORT, host: env.HOST });
