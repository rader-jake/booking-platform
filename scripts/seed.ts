/**
 * Seeds (or re-syncs) a tenant from its static booking page.
 *
 *   npm run seed -- --html ../doneup-booking/index.html \
 *     --slug doneupbyrissa --name "Done Up by Rissa" --timezone America/New_York \
 *     --calendar-id <id>@group.calendar.google.com --origins https://example.vercel.app,http://localhost:4321
 *
 * Refuses to touch a non-local database unless --confirm-remote is passed.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createDb } from "../src/db/client.js";
import { extractFrontendData, toSeedServices, toWeeklyHours } from "../src/seed/frontend-data.js";
import { seedTenant } from "../src/seed/seed-tenant.js";

const { values: args } = parseArgs({
  options: {
    html: { type: "string" },
    slug: { type: "string", default: "doneupbyrissa" },
    name: { type: "string", default: "Done Up by Rissa" },
    timezone: { type: "string", default: "America/New_York" },
    "calendar-id": { type: "string" },
    "busy-calendars": { type: "string", default: "" },
    origins: { type: "string", default: "" },
    "confirm-remote": { type: "boolean", default: false },
  },
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (!args.html) throw new Error("--html <path to the tenant's index.html> is required");

const host = new URL(databaseUrl).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host) && !args["confirm-remote"]) {
  throw new Error(`Refusing to seed remote database host "${host}" without --confirm-remote`);
}

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const data = extractFrontendData(await readFile(args.html, "utf8"));
const rows = toSeedServices(data);

const { db, pool } = createDb(databaseUrl);
try {
  const tenantId = await seedTenant(
    db,
    {
      slug: args.slug!,
      name: args.name!,
      timezone: args.timezone!,
      weeklyHours: toWeeklyHours(data.STUDIO_HOURS),
      slotIntervalMinutes: data.SLOT_INTERVAL,
      leadTimeMinutes: data.LEAD_TIME_MIN,
      depositCents: data.DEPOSIT_AMOUNT == null ? null : Math.round(data.DEPOSIT_AMOUNT * 100),
      googleCalendarId: args["calendar-id"] ?? null,
      busyCalendarIds: list(args["busy-calendars"]!),
      allowedOrigins: list(args.origins!),
    },
    rows,
  );
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.kind]: (acc[r.kind] ?? 0) + 1 }), {});
  console.log(`Seeded tenant ${args.slug} (${tenantId}):`, counts);
  if (!args["calendar-id"]) console.warn("No --calendar-id given: availability will return 503 until it is set.");
} finally {
  await pool.end();
}
