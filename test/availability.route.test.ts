import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookings } from "../src/db/schema.js";
import { createTenant, db, makeApp, pool, resetDb } from "./helpers.js";

afterAll(() => pool.end());
beforeEach(resetDb);

const get = async (app: Awaited<ReturnType<typeof makeApp>>["app"], url: string) => {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
};

describe("GET /api/:tenant/availability", () => {
  it("returns ISO start times with the tenant's offset", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const { status, body } = await get(app, "/api/rissa/availability?date=2026-10-06&serviceId=cut");
    expect(status).toBe(200);
    expect(body.timezone).toBe("America/New_York");
    expect(body.durationMinutes).toBe(60);
    expect(body.slots[0]).toBe("2026-10-06T12:00:00-04:00");
    expect(body.slots.at(-1)).toBe("2026-10-06T18:00:00-04:00");
  });

  it("subtracts Google busy time across the main and extra busy calendars", async () => {
    await createTenant({ slug: "rissa", busyCalendarIds: ["personal@calendar.test"] });
    const { app, calendar } = await makeApp();
    calendar.addBusy("rissa@calendar.test", { start: new Date("2026-10-06T13:00:00-04:00"), end: new Date("2026-10-06T14:00:00-04:00") });
    calendar.addBusy("personal@calendar.test", { start: new Date("2026-10-06T16:00:00-04:00"), end: new Date("2026-10-06T19:00:00-04:00") });
    const { body } = await get(app, "/api/rissa/availability?date=2026-10-06&serviceId=cut");
    const hm = body.slots.map((s: string) => s.slice(11, 16));
    expect(hm).toEqual(["12:00", "14:00", "14:30", "15:00"]);
  });

  it("subtracts existing active bookings including buffer, ignoring cancelled and expired holds", async () => {
    const t = await createTenant({ slug: "rissa", bufferMinutes: 30 });
    const { app } = await makeApp();
    const svc = await db.query.services.findFirst({ where: (s, { eq }) => eq(s.key, "cut") });
    const base = {
      tenantId: t.id, serviceId: svc!.id, totalPriceCents: 5000, totalDurationMinutes: 60,
      customerName: "x", customerEmail: "x@example.com", customerPhone: "5555555555", cancelTokenHash: "h",
    };
    await db.insert(bookings).values([
      { ...base, status: "confirmed", startsAt: new Date("2026-10-06T14:00:00-04:00"), endsAt: new Date("2026-10-06T15:00:00-04:00"), blockedUntil: new Date("2026-10-06T15:30:00-04:00") },
      { ...base, status: "cancelled", startsAt: new Date("2026-10-06T12:00:00-04:00"), endsAt: new Date("2026-10-06T13:00:00-04:00"), blockedUntil: new Date("2026-10-06T13:00:00-04:00") },
      { ...base, status: "pending_deposit", holdExpiresAt: new Date("2026-10-05T07:00:00-04:00"), // expired before "now"
        startsAt: new Date("2026-10-06T17:00:00-04:00"), endsAt: new Date("2026-10-06T18:00:00-04:00"), blockedUntil: new Date("2026-10-06T18:00:00-04:00") },
    ]);
    const { body } = await get(app, "/api/rissa/availability?date=2026-10-06&serviceId=cut");
    const hm = body.slots.map((s: string) => s.slice(11, 16));
    // 12:30 + 60min + 30min buffer ends exactly at 14:00 (allowed); 13:00..15:00 overlap the
    // 14:00 booking, whose own buffer blocks until 15:30. 12:00 is free (cancelled) and 17:00 too (expired hold).
    expect(hm).toEqual(["12:00", "12:30", "15:30", "16:00", "16:30", "17:00", "17:30", "18:00"]);
  });

  it("adds add-on durations and reports the server-computed price", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const { body } = await get(app, "/api/rissa/availability?date=2026-10-07&serviceId=bundle-set&addons=extra-bundle,after-hours");
    expect(body.durationMinutes).toBe(165);
    expect(body.totalPriceCents).toBe(40000 + 9500 + 6500);
    expect(body.slots.at(-1)).toBe("2026-10-07T16:00:00-04:00"); // 16:00 + 2h45 = 18:45; 16:30 would overrun 19:00
  });

  it("enforces the service's minimum notice", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp(); // Monday
    expect((await get(app, "/api/rissa/availability?date=2026-10-06&serviceId=bundle-set")).body.slots).toEqual([]);
    expect((await get(app, "/api/rissa/availability?date=2026-10-07&serviceId=bundle-set")).body.slots.length).toBeGreaterThan(0);
  });

  it("rejects add-ons that don't apply to the service", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const { status, body } = await get(app, "/api/rissa/availability?date=2026-10-06&serviceId=cut&addons=extra-bundle");
    expect(status).toBe(400);
    expect(body.error.code).toBe("INVALID_ADDON");
  });

  it("validates the query with a consistent error shape", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const { status, body } = await get(app, "/api/rissa/availability?date=10/06/2026&serviceId=cut");
    expect(status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details[0].path).toBe("date");
  });

  it("returns 404 for unknown tenants and unknown services", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    expect((await get(app, "/api/nobody/availability?date=2026-10-06&serviceId=cut")).status).toBe(404);
    expect((await get(app, "/api/nobody/services")).body).toEqual({ error: { code: "NOT_FOUND", message: "Business not found" } });
    expect((await get(app, "/api/rissa/availability?date=2026-10-06&serviceId=nope")).status).toBe(404);
  });

  it("fails closed with 503 when the calendar can't be read or isn't connected", async () => {
    await createTenant({ slug: "rissa" });
    await createTenant({ slug: "nocal", googleCalendarId: null });
    const { app, calendar } = await makeApp();
    calendar.failNext("freeBusy");
    const failed = await get(app, "/api/rissa/availability?date=2026-10-06&serviceId=cut");
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe("CALENDAR_UNAVAILABLE");
    expect((await get(app, "/api/nocal/availability?date=2026-10-06&serviceId=cut")).status).toBe(503);
  });
});

describe("GET /api/:tenant/services", () => {
  it("lists the tenant's catalog with applicable add-ons", async () => {
    await createTenant({ slug: "rissa", depositCents: 5000 });
    const { app } = await makeApp();
    const { status, body } = await get(app, "/api/rissa/services");
    expect(status).toBe(200);
    expect(body.tenant.depositCents).toBe(5000);
    expect(body.services.map((s: { id: string }) => s.id)).toEqual(["cut", "bundle-set"]);
    expect(body.services[1].addons).toEqual(expect.arrayContaining(["extra-bundle", "closure", "after-hours"]));
    expect(body.services[0].addons).toEqual(["after-hours"]);
  });
});

describe("CORS", () => {
  it("only allows the tenant's own origins", async () => {
    await createTenant({ slug: "rissa" });
    await createTenant({ slug: "other" });
    const { app } = await makeApp();
    const ok = await app.inject({ method: "GET", url: "/api/rissa/services", headers: { origin: "https://rissa.example" } });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://rissa.example");
    const blocked = await app.inject({ method: "GET", url: "/api/rissa/services", headers: { origin: "https://other.example" } });
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
