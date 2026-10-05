import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { serviceAddons, services, tenants } from "../src/db/schema.js";
import { extractFrontendData, toSeedServices, toWeeklyHours } from "../src/seed/frontend-data.js";
import { seedTenant } from "../src/seed/seed-tenant.js";
import { db, pool, resetDb } from "./helpers.js";

afterAll(() => pool.end());
beforeEach(resetDb);

const fixture = `<script>
  const API = "ignored";
  const STUDIO_HOURS = { 0: null, 2: [{ open: 12*60, close: 19*60 }], 3: [{ open: 600, close: 780 }, { open: 900, close: 1140 }] };
  const DEPOSIT_AMOUNT = 50;
  const SLOT_INTERVAL = 30;
  const LEAD_TIME_MIN = 180;
  const ADDONS = { "extra": { name: "+1 Bundle", price: 95, duration: 15 } };
  const UNIVERSAL_ADDONS = { "late": { name: "After Hours", price: 65, duration: 0 } };
  const CATEGORIES = [{ name: "Cat", services: [
    { id: "a", name: "A", price: 495, duration: 150, addons: ["extra"], minDaysNotice: 2, desc: "d" },
    { id: "b", name: "B", price: 19.99, duration: 45 },
  ]}];
  const SERVICES = {};
  document.getElementById("x"); // never evaluated
</script>`;

describe("seed from frontend HTML", () => {
  it("extracts hours (incl. split shifts), money in cents, notice, and applies_to without evaluating DOM code", () => {
    const data = extractFrontendData(fixture);
    expect(toWeeklyHours(data.STUDIO_HOURS)).toEqual({
      "2": [{ start: "12:00", end: "19:00" }],
      "3": [{ start: "10:00", end: "13:00" }, { start: "15:00", end: "19:00" }],
    });
    const rows = toSeedServices(data);
    expect(rows.find((r) => r.key === "a")).toMatchObject({ kind: "service", priceCents: 49500, minDaysNotice: 2, addonKeys: ["extra"] });
    expect(rows.find((r) => r.key === "b")).toMatchObject({ priceCents: 1999, minDaysNotice: 0 });
    expect(rows.find((r) => r.key === "late")).toMatchObject({ kind: "universal_addon", priceCents: 6500 });
  });

  it("rejects unknown add-on references and key collisions", () => {
    expect(() => toSeedServices(extractFrontendData(fixture.replace('addons: ["extra"]', 'addons: ["missing"]')))).toThrow(/unknown add-on/);
    expect(() => toSeedServices(extractFrontendData(fixture.replace('"late":', '"a":')))).toThrow(/Duplicate/);
  });

  it("is idempotent and deactivates removed services instead of deleting them", async () => {
    const input = {
      slug: "t", name: "T", timezone: "America/New_York", weeklyHours: {}, slotIntervalMinutes: 30, leadTimeMinutes: 180,
      depositCents: 5000, googleCalendarId: null, busyCalendarIds: [], allowedOrigins: [],
    };
    const rows = toSeedServices(extractFrontendData(fixture));
    await seedTenant(db, input, rows);
    await seedTenant(db, input, rows);
    expect(await db.select().from(tenants)).toHaveLength(1);
    expect(await db.select().from(services)).toHaveLength(4);
    expect(await db.select().from(serviceAddons)).toHaveLength(1);

    await seedTenant(db, input, rows.filter((r) => r.key !== "b"));
    const b = (await db.select().from(services)).find((s) => s.key === "b");
    expect(b!.active).toBe(false);
  });

  const realPage = process.env.FRONTEND_HTML ?? "../doneup-booking/index.html";
  it.skipIf(!existsSync(realPage))("parses Rissa's real booking page", () => {
    const data = extractFrontendData(readFileSync(realPage, "utf8"));
    const rows = toSeedServices(data);
    expect(rows.filter((r) => r.kind === "service").length).toBeGreaterThanOrEqual(32);
    expect(data.DEPOSIT_AMOUNT).toBe(50);
    expect(rows.filter((r) => r.minDaysNotice === 2).map((r) => r.key)).toEqual(["bundle-20-24", "bundle-18-18-18", "bundle-18-22", "bundle-22-26"]);
  });
});
