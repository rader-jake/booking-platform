import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { candidateStarts, subtractBusy, toTenantIso, type SlotRules } from "../src/domain/availability.js";

const TZ = "America/New_York";
const rules = (over: Partial<SlotRules> = {}): SlotRules => ({
  timezone: TZ,
  weeklyHours: { "2": [{ start: "12:00", end: "19:00" }] },
  slotIntervalMinutes: 30,
  leadTimeMinutes: 0,
  bufferMinutes: 0,
  maxDaysAhead: 365,
  ...over,
});
const LONG_AGO = new Date("2026-01-01T00:00:00Z");
const iso = (ts: DateTime[]) => ts.map((t) => toTenantIso(t, TZ));
const times = (ts: DateTime[]) => ts.map((t) => t.setZone(TZ).toFormat("HH:mm"));

describe("candidateStarts", () => {
  it("follows the slot grid and requires the whole appointment to fit in a window", () => {
    const out = candidateStarts(rules(), { date: "2026-10-06", durationMinutes: 150, minDaysNotice: 0, now: LONG_AGO });
    expect(times(out)).toEqual([
      "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30",
    ]); // 16:30 + 2h30 = 19:00 exactly; 17:00 would end at 19:30
  });

  it("supports split shifts (several windows in one day)", () => {
    const r = rules({ weeklyHours: { "3": [{ start: "10:00", end: "13:00" }, { start: "15:00", end: "18:00" }] } });
    const out = candidateStarts(r, { date: "2026-10-07", durationMinutes: 60, minDaysNotice: 0, now: LONG_AGO });
    expect(times(out)).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "15:00", "15:30", "16:00", "16:30", "17:00"]);
  });

  it("returns nothing on closed days", () => {
    expect(candidateStarts(rules(), { date: "2026-10-05", durationMinutes: 60, minDaysNotice: 0, now: LONG_AGO })).toEqual([]);
  });

  it("drops starts earlier than now + lead time", () => {
    const now = new Date("2026-10-06T10:15:00-04:00");
    const out = candidateStarts(rules({ leadTimeMinutes: 180 }), { date: "2026-10-06", durationMinutes: 60, minDaysNotice: 0, now });
    expect(times(out)[0]).toBe("13:30"); // 10:15 + 3h = 13:15 → next grid slot
  });

  it("enforces minimum notice in calendar days in the tenant timezone", () => {
    const r = rules({ weeklyHours: { "2": [{ start: "12:00", end: "19:00" }], "3": [{ start: "10:00", end: "19:00" }] } });
    // Monday 11:30pm in New York is already Tuesday in UTC; notice must still count from Monday.
    const now = new Date("2026-10-05T23:30:00-04:00");
    const req = { durationMinutes: 60, minDaysNotice: 2, now };
    expect(candidateStarts(r, { ...req, date: "2026-10-06" })).toEqual([]);
    expect(candidateStarts(r, { ...req, date: "2026-10-07" }).length).toBeGreaterThan(0);
  });

  it("refuses dates beyond max_days_ahead and in the past", () => {
    const now = new Date("2026-10-05T08:00:00-04:00");
    const r = rules({ maxDaysAhead: 7 });
    expect(candidateStarts(r, { date: "2026-10-13", durationMinutes: 60, minDaysNotice: 0, now })).toEqual([]);
    expect(candidateStarts(r, { date: "2026-09-29", durationMinutes: 60, minDaysNotice: 0, now })).toEqual([]);
  });

  it("rejects malformed dates", () => {
    expect(() => candidateStarts(rules(), { date: "2026-02-30", durationMinutes: 60, minDaysNotice: 0, now: LONG_AGO })).toThrow();
  });
});

describe("DST", () => {
  it("uses the right UTC offset on either side of the fall-back change", () => {
    const r = rules({ weeklyHours: { "6": [{ start: "12:00", end: "13:00" }], "2": [{ start: "12:00", end: "13:00" }] } });
    const before = candidateStarts(r, { date: "2026-10-31", durationMinutes: 60, minDaysNotice: 0, now: LONG_AGO });
    const after = candidateStarts(r, { date: "2026-11-03", durationMinutes: 60, minDaysNotice: 0, now: LONG_AGO });
    expect(iso(before)).toEqual(["2026-10-31T12:00:00-04:00"]);
    expect(iso(after)).toEqual(["2026-11-03T12:00:00-05:00"]);
    expect(before[0]!.toUTC().hour).toBe(16);
    expect(after[0]!.toUTC().hour).toBe(17);
  });

  it("on fall-back day (Nov 1 2026), a window spanning 1-2am yields distinct instants, none duplicated", () => {
    const r = rules({ weeklyHours: { "0": [{ start: "00:00", end: "04:00" }] }, slotIntervalMinutes: 60 });
    const out = candidateStarts(r, { date: "2026-11-01", durationMinutes: 60, minDaysNotice: 0, now: LONG_AGO });
    expect(iso(out)).toEqual([
      "2026-11-01T00:00:00-04:00",
      "2026-11-01T01:00:00-04:00",
      "2026-11-01T01:00:00-05:00", // the repeated 1am hour, one real hour later
      "2026-11-01T02:00:00-05:00",
      "2026-11-01T03:00:00-05:00",
    ]);
    expect(new Set(out.map((t) => t.toMillis())).size).toBe(out.length);
  });

  it("on spring-forward day (Mar 8 2026), the skipped 2am hour is never offered", () => {
    const r = rules({ weeklyHours: { "0": [{ start: "00:00", end: "04:00" }] }, slotIntervalMinutes: 60 });
    const out = candidateStarts(r, { date: "2026-03-08", durationMinutes: 60, minDaysNotice: 0, now: LONG_AGO });
    expect(iso(out)).toEqual(["2026-03-08T00:00:00-05:00", "2026-03-08T01:00:00-05:00", "2026-03-08T03:00:00-04:00"]);
  });
});

describe("subtractBusy", () => {
  const day = (hhmm: string) => DateTime.fromISO(`2026-10-06T${hhmm}`, { zone: TZ });
  const busy = [{ start: day("11:00").toJSDate(), end: day("12:00").toJSDate() }];

  it("removes starts whose appointment + buffer overlaps busy time", () => {
    const starts = ["09:30", "10:00", "10:30", "12:00"].map(day);
    expect(times(subtractBusy(starts, 60, 0, busy))).toEqual(["09:30", "10:00", "12:00"]);
    expect(times(subtractBusy(starts, 60, 15, busy))).toEqual(["09:30", "12:00"]); // 10:00 + 75min hits 11:00
  });

  it("treats intervals as half-open (back-to-back is fine)", () => {
    expect(times(subtractBusy([day("10:00")], 60, 0, busy))).toEqual(["10:00"]);
  });
});
