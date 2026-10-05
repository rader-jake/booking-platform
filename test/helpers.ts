import { sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { FakeCalendarProvider } from "../src/calendar/fake.js";
import { createDb, type Db } from "../src/db/client.js";
import { serviceAddons, services, tenants, type WeeklyHours } from "../src/db/schema.js";
import { TEST_DATABASE_URL } from "./db-url.js";

export const { db, pool } = createDb(TEST_DATABASE_URL);

export async function resetDb() {
  await db.execute(sql`TRUNCATE tenants, services, service_addons, bookings, booking_addons, waitlist_entries CASCADE`);
}

/** Monday 2026-10-05 08:00 in New York. */
export const MONDAY_8AM = new Date("2026-10-05T08:00:00-04:00");

export const RISSA_HOURS: WeeklyHours = {
  "2": [{ start: "12:00", end: "19:00" }],
  "3": [{ start: "10:00", end: "19:00" }],
  "4": [{ start: "10:00", end: "19:00" }],
  "5": [{ start: "10:00", end: "19:00" }],
  "6": [{ start: "10:00", end: "17:00" }],
};

type TenantOpts = Partial<typeof tenants.$inferInsert> & { slug: string };

/**
 * A tenant with a small catalog:
 *   cut (60 min, $50) · bundle-set (150 min, $400, 2 days notice)
 *   addons: extra-bundle (15 min, $95) → bundle-set only · closure (10 min, $75) → bundle-set only
 *   universal: after-hours ($65, price only)
 */
export async function createTenant(opts: TenantOpts) {
  const [tenant] = await db
    .insert(tenants)
    .values({
      name: `Tenant ${opts.slug}`,
      timezone: "America/New_York",
      weeklyHours: RISSA_HOURS,
      googleCalendarId: `${opts.slug}@calendar.test`,
      allowedOrigins: [`https://${opts.slug}.example`],
      ...opts,
    })
    .returning();
  const t = tenant!;
  const rows = await db
    .insert(services)
    .values([
      { tenantId: t.id, key: "cut", kind: "service" as const, name: "Cut", priceCents: 5000, durationMinutes: 60, sortOrder: 1 },
      { tenantId: t.id, key: "bundle-set", kind: "service" as const, name: "Bundle Set", priceCents: 40000, durationMinutes: 150, minDaysNotice: 2, sortOrder: 2 },
      { tenantId: t.id, key: "extra-bundle", kind: "addon" as const, name: "+1 Bundle", priceCents: 9500, durationMinutes: 15, sortOrder: 3 },
      { tenantId: t.id, key: "closure", kind: "addon" as const, name: "Closure", priceCents: 7500, durationMinutes: 10, sortOrder: 4 },
      { tenantId: t.id, key: "after-hours", kind: "universal_addon" as const, name: "After Hours", priceCents: 6500, durationMinutes: 0, sortOrder: 5 },
    ])
    .returning();
  const id = (key: string) => rows.find((r) => r.key === key)!.id;
  await db.insert(serviceAddons).values([
    { tenantId: t.id, serviceId: id("bundle-set"), addonId: id("extra-bundle") },
    { tenantId: t.id, serviceId: id("bundle-set"), addonId: id("closure") },
  ]);
  return t;
}

export async function makeApp(opts: { now?: Date; calendar?: FakeCalendarProvider; db?: Db } = {}) {
  const calendar = opts.calendar ?? new FakeCalendarProvider();
  let now = opts.now ?? MONDAY_8AM;
  const app = await buildApp({ db: opts.db ?? db, calendar, now: () => now, logLevel: "silent", rateLimit: false, calendarRetryDelaysMs: [0, 0] });
  return { app, calendar, setNow: (d: Date) => (now = d) };
}
