import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { confirmBooking } from "../src/booking/bookings.js";
import { createDb } from "../src/db/client.js";
import { bookingAddons, bookings, services } from "../src/db/schema.js";
import { TEST_DATABASE_URL } from "./db-url.js";
import { createTenant, db, makeApp, pool, resetDb } from "./helpers.js";

afterAll(() => pool.end());
beforeEach(resetDb);

type App = Awaited<ReturnType<typeof makeApp>>["app"];
/** Transactions rolled back in the test DB (each 409 from the constraint is one). */
async function rollbackCount() {
  await db.execute(sql`select pg_stat_clear_snapshot()`);
  const { rows } = await db.execute(sql`select xact_rollback from pg_stat_database where datname = current_database()`);
  return Number((rows[0] as { xact_rollback: string }).xact_rollback);
}

const customer = { name: "Test Client", email: "client@example.com", phone: "+15551234567" };
const post = (app: App, slug: string, body: object) =>
  app.inject({ method: "POST", url: `/api/${slug}/bookings`, payload: { ...customer, ...body } });

describe("POST /api/:tenant/bookings", () => {
  it("books a confirmed appointment, writes one calendar event, and stores only a token hash", async () => {
    await createTenant({ slug: "rissa" });
    const { app, calendar } = await makeApp();
    const res = await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00", notes: "Body Wave" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.booking).toMatchObject({
      status: "confirmed",
      startsAt: "2026-10-06T13:00:00-04:00",
      endsAt: "2026-10-06T14:00:00-04:00",
      totalPriceCents: 5000,
      holdExpiresAt: null,
    });
    expect(body.cancelToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);

    const [row] = await db.select().from(bookings);
    expect(row!.cancelTokenHash).not.toContain(body.cancelToken);
    expect(row!.cancelTokenHash).toHaveLength(64);
    const events = calendar.eventsFor("rissa@calendar.test");
    expect(events).toHaveLength(1);
    expect(row!.calendarEventId).toBeTruthy();
    expect(events[0]!.start.toISOString()).toBe("2026-10-06T17:00:00.000Z");
    expect(events[0]!.description).toContain("Notes: Body Wave");
  });

  it("recomputes price and duration server-side and ignores client-sent totals", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const res = await post(app, "rissa", {
      serviceId: "bundle-set",
      addons: ["extra-bundle", "after-hours"],
      startsAt: "2026-10-07T10:00:00-04:00",
      totalPriceCents: 1,
      price: 1,
      durationMinutes: 5,
    });
    expect(res.statusCode).toBe(201);
    const { booking } = res.json();
    expect(booking.totalPriceCents).toBe(40000 + 9500 + 6500);
    expect(booking.totalDurationMinutes).toBe(150 + 15);
    expect(booking.endsAt).toBe("2026-10-07T12:45:00-04:00");
    const snap = await db.select().from(bookingAddons);
    expect(snap.map((a) => a.priceCents).sort()).toEqual([6500, 9500]);
  });

  it("rejects add-ons that don't apply to the chosen service, and duplicates", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const wrong = await post(app, "rissa", { serviceId: "cut", addons: ["closure"], startsAt: "2026-10-06T13:00:00-04:00" });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe("INVALID_ADDON");
    const dup = await post(app, "rissa", { serviceId: "bundle-set", addons: ["closure", "closure"], startsAt: "2026-10-07T10:00:00-04:00" });
    expect(dup.json().error.code).toBe("DUPLICATE_ADDON");
    expect(await db.select().from(bookings)).toHaveLength(0);
  });

  it("rejects starts the server wouldn't offer (off-grid, closed, inside min notice)", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    for (const [serviceId, startsAt] of [
      ["cut", "2026-10-06T13:10:00-04:00"], // off the 30-min grid
      ["cut", "2026-10-05T13:00:00-04:00"], // closed Monday
      ["cut", "2026-10-06T18:30:00-04:00"], // would end after 7pm
      ["bundle-set", "2026-10-06T12:00:00-04:00"], // needs 2 days notice
    ]) {
      const res = await post(app, "rissa", { serviceId, startsAt });
      expect(res.statusCode, `${serviceId} @ ${startsAt}`).toBe(400);
      expect(res.json().error.code).toBe("INVALID_START");
    }
  });

  it("validates input with length limits", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const res = await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00", name: "x".repeat(101), email: "nope" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(res.json().error.details.map((d: { path: string }) => d.path).sort()).toEqual(["email", "name"]);
  });

  it("returns 409 when the slot is already taken", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    expect((await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" })).statusCode).toBe(201);
    const second = await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:30:00-04:00" });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toEqual({ code: "SLOT_TAKEN", message: "That time was just taken. Please pick another time." });
  });

  it("concurrency: of simultaneous POSTs for the same slot, exactly one succeeds", async () => {
    await createTenant({ slug: "rissa" });
    // Own pool so closing it flushes Postgres's per-backend stats (rollback counter) right away.
    const raceDb = createDb(TEST_DATABASE_URL);
    const { app, calendar } = await makeApp({ db: raceDb.db });
    // Every request passes the app-level availability check before any insert lands,
    // so only the Postgres exclusion constraint can stop the losers.
    calendar.freeBusyDelayMs = 100;
    const rollbacksBefore = await rollbackCount();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T15:00:00-04:00", email: `c${i}@example.com` }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409, 409, 409]);
    expect(await db.select().from(bookings)).toHaveLength(1);
    expect(calendar.eventsFor("rissa@calendar.test")).toHaveLength(1);
    await raceDb.pool.end();
    await expect.poll(async () => (await rollbackCount()) - rollbacksBefore, { timeout: 5000 }).toBeGreaterThanOrEqual(7);
  });

  it("the database itself rejects overlapping active bookings (exclusion constraint)", async () => {
    const t = await createTenant({ slug: "rissa" });
    const [svc] = await db.select().from(services).where(eq(services.key, "cut"));
    const row = (start: string, end: string, status: "confirmed" | "cancelled" = "confirmed") => ({
      tenantId: t.id, serviceId: svc!.id, status, startsAt: new Date(start), endsAt: new Date(end), blockedUntil: new Date(end),
      totalPriceCents: 1, totalDurationMinutes: 60, customerName: "x", customerEmail: "x@example.com", customerPhone: "1", cancelTokenHash: "h",
    });
    await db.insert(bookings).values(row("2026-10-06T16:00:00Z", "2026-10-06T17:00:00Z"));
    await expect(db.insert(bookings).values(row("2026-10-06T16:30:00Z", "2026-10-06T17:30:00Z"))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: "23P01" }),
    });
    // Cancelled rows and back-to-back rows don't conflict.
    await db.insert(bookings).values(row("2026-10-06T16:30:00Z", "2026-10-06T17:30:00Z", "cancelled"));
    await db.insert(bookings).values(row("2026-10-06T17:00:00Z", "2026-10-06T18:00:00Z"));
  });

  it("rolls the booking back if the calendar write fails", async () => {
    await createTenant({ slug: "rissa" });
    const { app, calendar } = await makeApp();
    calendar.failNext("createEvent");
    const res = await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("CALENDAR_UNAVAILABLE");
    expect(await db.select().from(bookings)).toHaveLength(0);
    expect(await db.select().from(bookingAddons)).toHaveLength(0);
    // And the slot is still bookable.
    expect((await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" })).statusCode).toBe(201);
  });
});

describe("deposit tenants (pending_deposit holds)", () => {
  it("holds the slot without a calendar event until confirmed", async () => {
    await createTenant({ slug: "rissa", depositCents: 5000, depositHoldMinutes: 30 });
    const { app, calendar } = await makeApp();
    const res = await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" });
    expect(res.statusCode).toBe(201);
    expect(res.json().booking).toMatchObject({
      status: "pending_deposit",
      depositCents: 5000,
      holdExpiresAt: "2026-10-05T08:30:00-04:00",
      depositUrl: null,
    });
    expect(calendar.eventsFor("rissa@calendar.test")).toHaveLength(0);
    const avail = await app.inject({ method: "GET", url: "/api/rissa/availability?date=2026-10-06&serviceId=cut" });
    expect(avail.json().slots).not.toContain("2026-10-06T13:00:00-04:00");
    expect((await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" })).statusCode).toBe(409);
  });

  it("releases the slot when the hold expires", async () => {
    await createTenant({ slug: "rissa", depositCents: 5000, depositHoldMinutes: 30 });
    const { app, setNow } = await makeApp();
    await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" });
    setNow(new Date("2026-10-05T08:31:00-04:00"));
    const avail = await app.inject({ method: "GET", url: "/api/rissa/availability?date=2026-10-06&serviceId=cut" });
    expect(avail.json().slots).toContain("2026-10-06T13:00:00-04:00");
    expect((await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" })).statusCode).toBe(201);
    const statuses = (await db.select().from(bookings)).map((b) => b.status).sort();
    expect(statuses).toEqual(["expired", "pending_deposit"]);
  });

  it("confirmBooking (phase-2 payment hook) writes the calendar event, and rolls back if that fails", async () => {
    const tenant = await createTenant({ slug: "rissa", depositCents: 5000 });
    const { app, calendar } = await makeApp();
    const { booking } = (await post(app, "rissa", { serviceId: "cut", startsAt: "2026-10-06T13:00:00-04:00" })).json();
    const deps = { ...app.deps, log: app.log };

    calendar.failNext("createEvent");
    await expect(confirmBooking(deps, tenant, booking.id)).rejects.toMatchObject({ statusCode: 503 });
    expect((await db.select().from(bookings))[0]!.status).toBe("pending_deposit");

    const confirmed = await confirmBooking(deps, tenant, booking.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.holdExpiresAt).toBeNull();
    expect(calendar.eventsFor("rissa@calendar.test")).toHaveLength(1);
  });
});
