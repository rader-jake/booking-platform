import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bookings, services, waitlistEntries } from "../src/db/schema.js";
import { createTenant, db, makeApp, pool, resetDb } from "./helpers.js";

afterAll(() => pool.end());
beforeEach(resetDb);

type App = Awaited<ReturnType<typeof makeApp>>["app"];
const customer = { name: "Test Client", email: "client@example.com", phone: "+15551234567" };
const book = async (app: App, slug: string, startsAt = "2026-10-06T13:00:00-04:00") => {
  const res = await app.inject({ method: "POST", url: `/api/${slug}/bookings`, payload: { ...customer, serviceId: "cut", startsAt } });
  expect(res.statusCode).toBe(201);
  return res.json() as { booking: { id: string }; cancelToken: string };
};
const cancel = (app: App, slug: string, id: string, token: string) =>
  app.inject({ method: "DELETE", url: `/api/${slug}/bookings/${id}?token=${encodeURIComponent(token)}` });
const slots = async (app: App, slug: string) =>
  (await app.inject({ method: "GET", url: `/api/${slug}/availability?date=2026-10-06&serviceId=cut` })).json().slots as string[];

describe("DELETE /api/:tenant/bookings/:id", () => {
  it("cancels with the token, removes the calendar event, frees the slot, and is idempotent", async () => {
    await createTenant({ slug: "rissa" });
    const { app, calendar } = await makeApp();
    const { booking, cancelToken } = await book(app, "rissa");
    expect(calendar.eventsFor("rissa@calendar.test")).toHaveLength(1);

    const res = await cancel(app, "rissa", booking.id, cancelToken);
    expect(res.statusCode).toBe(200);
    expect(res.json().booking.status).toBe("cancelled");
    expect(calendar.eventsFor("rissa@calendar.test")).toHaveLength(0);
    expect(await slots(app, "rissa")).toContain("2026-10-06T13:00:00-04:00");

    const again = await cancel(app, "rissa", booking.id, cancelToken);
    expect(again.statusCode).toBe(200);
    expect(calendar.calls.deleteEvent).toBe(1);
  });

  it("accepts a DELETE that sends Content-Type: application/json with no body", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const { booking, cancelToken } = await book(app, "rissa");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/rissa/bookings/${booking.id}?token=${cancelToken}`,
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(200);
    const bad = await app.inject({ method: "POST", url: "/api/rissa/waitlist", headers: { "content-type": "application/json" }, payload: "{nope" });
    expect(bad.json().error.code).toBe("INVALID_JSON");
  });

  it("returns 404 for a wrong token, an unknown id, or a malformed id", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const { booking, cancelToken } = await book(app, "rissa");
    expect((await cancel(app, "rissa", booking.id, "x".repeat(43))).statusCode).toBe(404);
    expect((await cancel(app, "rissa", "00000000-0000-4000-8000-000000000000", cancelToken)).statusCode).toBe(404);
    expect((await cancel(app, "rissa", "not-a-uuid", cancelToken)).statusCode).toBe(404);
    expect((await db.select().from(bookings))[0]!.status).toBe("confirmed");
  });

  it("retries a failed calendar delete", async () => {
    await createTenant({ slug: "rissa" });
    const { app, calendar } = await makeApp();
    const { booking, cancelToken } = await book(app, "rissa");
    calendar.failNext("deleteEvent", 2);
    const res = await cancel(app, "rissa", booking.id, cancelToken);
    expect(res.statusCode).toBe(200);
    expect(calendar.calls.deleteEvent).toBe(3);
    expect(calendar.eventsFor("rissa@calendar.test")).toHaveLength(0);
    expect((await db.select().from(bookings))[0]!.calendarSyncPending).toBe(false);
  });

  it("flags the booking for reconciliation if the calendar delete keeps failing", async () => {
    await createTenant({ slug: "rissa" });
    const { app, calendar } = await makeApp();
    const { booking, cancelToken } = await book(app, "rissa");
    calendar.failNext("deleteEvent", 10);
    const res = await cancel(app, "rissa", booking.id, cancelToken);
    expect(res.statusCode).toBe(200);
    const [row] = await db.select().from(bookings);
    expect(row!.status).toBe("cancelled");
    expect(row!.calendarSyncPending).toBe(true);
  });

  it("cancels a pending-deposit hold (no calendar event to remove)", async () => {
    await createTenant({ slug: "rissa", depositCents: 5000 });
    const { app, calendar } = await makeApp();
    const { booking, cancelToken } = await book(app, "rissa");
    expect((await cancel(app, "rissa", booking.id, cancelToken)).json().booking.status).toBe("cancelled");
    expect(calendar.calls.deleteEvent).toBe(0);
    expect(await slots(app, "rissa")).toContain("2026-10-06T13:00:00-04:00");
  });
});

describe("tenant isolation", () => {
  it("tenant A can't see, block, or cancel tenant B's bookings", async () => {
    await createTenant({ slug: "alpha" });
    await createTenant({ slug: "bravo" });
    const { app } = await makeApp();

    const b = await book(app, "bravo");
    // Same time is still open for alpha, and alpha can book it (constraint is per tenant).
    expect(await slots(app, "alpha")).toContain("2026-10-06T13:00:00-04:00");
    await book(app, "alpha");

    // Bravo's id + valid token through alpha's routes: indistinguishable from "doesn't exist".
    const cross = await cancel(app, "alpha", b.booking.id, b.cancelToken);
    expect(cross.statusCode).toBe(404);
    const rows = await db.select().from(bookings);
    expect(rows.every((r) => r.status === "confirmed")).toBe(true);
  });

  it("services and add-ons are scoped to their tenant", async () => {
    const a = await createTenant({ slug: "alpha" });
    await createTenant({ slug: "bravo" });
    const { app } = await makeApp();
    await db.insert(services).values({ tenantId: a.id, key: "alpha-only", kind: "service", name: "Alpha only", priceCents: 1, durationMinutes: 30 });

    const bravoServices = (await app.inject({ method: "GET", url: "/api/bravo/services" })).json().services;
    expect(bravoServices.map((s: { id: string }) => s.id)).not.toContain("alpha-only");
    const res = await app.inject({ method: "GET", url: "/api/bravo/availability?date=2026-10-06&serviceId=alpha-only" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/:tenant/waitlist", () => {
  const join = (app: App, slug: string, body: object) =>
    app.inject({ method: "POST", url: `/api/${slug}/waitlist`, payload: { ...customer, serviceId: "cut", date: "2026-10-06", ...body } });

  it("stores the entry against the tenant", async () => {
    const t = await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    const res = await join(app, "rissa", {});
    expect(res.statusCode).toBe(201);
    const [row] = await db.select().from(waitlistEntries);
    expect(row).toMatchObject({ id: res.json().id, tenantId: t.id, preferredDate: "2026-10-06", customerEmail: "client@example.com" });
  });

  it("validates service, date, and contact fields", async () => {
    await createTenant({ slug: "rissa" });
    const { app } = await makeApp();
    expect((await join(app, "rissa", { serviceId: "nope" })).statusCode).toBe(404);
    expect((await join(app, "rissa", { date: "2026-10-01" })).json().error.code).toBe("VALIDATION_ERROR");
    expect((await join(app, "rissa", { email: "bad" })).statusCode).toBe(400);
    expect((await join(app, "nobody", {})).statusCode).toBe(404);
    expect(await db.select().from(waitlistEntries)).toHaveLength(0);
  });
});

describe("rate limiting", () => {
  it("limits writes more strictly than reads, with the standard error shape", async () => {
    await createTenant({ slug: "rissa" });
    const { buildApp } = await import("../src/app.js");
    const { FakeCalendarProvider } = await import("../src/calendar/fake.js");
    const app = await buildApp({ db, calendar: new FakeCalendarProvider(), logLevel: "silent" });
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({ method: "POST", url: "/api/rissa/waitlist", payload: { ...customer, serviceId: "cut", date: "2026-12-01" } });
      codes.push(res.statusCode);
      if (res.statusCode === 429) expect(res.json().error.code).toBe("RATE_LIMITED");
    }
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await app.inject({ method: "GET", url: "/api/rissa/services" })).statusCode).toBe(200);
  });
});
