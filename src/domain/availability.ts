import { DateTime } from "luxon";
import type { WeeklyHours } from "../db/schema.js";

export type Interval = { start: Date; end: Date };

export type SlotRules = {
  timezone: string;
  weeklyHours: WeeklyHours;
  slotIntervalMinutes: number;
  leadTimeMinutes: number;
  bufferMinutes: number;
  maxDaysAhead: number;
};

export type SlotRequest = {
  /** YYYY-MM-DD, interpreted in the tenant's timezone. */
  date: string;
  durationMinutes: number;
  minDaysNotice: number;
  now: Date;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseTenantDate(date: string, timezone: string): DateTime {
  const day = DATE_RE.test(date) ? DateTime.fromISO(date, { zone: timezone }) : DateTime.invalid("bad format");
  if (!day.isValid) throw new RangeError(`Invalid date "${date}"`);
  return day.startOf("day");
}

/** The UTC instants bounding a tenant-local calendar day (23 or 25 hours long on DST days). */
export function dayBounds(date: string, timezone: string): Interval {
  const day = parseTenantDate(date, timezone);
  return { start: day.toJSDate(), end: day.plus({ days: 1 }).toJSDate() };
}

function atWallClock(day: DateTime, hhmm: string): DateTime {
  const [h, m] = hhmm.split(":").map(Number);
  return day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

/**
 * Candidate start times for one day, before anything busy is subtracted: the slot grid inside
 * each opening window, where the whole appointment fits in the window, at least lead time from
 * now, and not inside the service's minimum notice (counted in calendar days, tenant time).
 *
 * Stepping is done in absolute minutes from each window's opening, so a window that spans a DST
 * change never produces duplicate or skipped instants.
 */
export function candidateStarts(rules: SlotRules, req: SlotRequest): DateTime[] {
  const day = parseTenantDate(req.date, rules.timezone);
  const today = DateTime.fromJSDate(req.now, { zone: rules.timezone }).startOf("day");

  if (day < today.plus({ days: req.minDaysNotice })) return [];
  if (day > today.plus({ days: rules.maxDaysAhead })) return [];

  const windows = rules.weeklyHours[String(day.weekday % 7) as keyof WeeklyHours] ?? [];
  const earliest = DateTime.fromJSDate(req.now).plus({ minutes: rules.leadTimeMinutes });
  const out: DateTime[] = [];

  for (const w of windows) {
    const open = atWallClock(day, w.start);
    const close = atWallClock(day, w.end);
    for (let t = open; t.plus({ minutes: req.durationMinutes }) <= close; t = t.plus({ minutes: rules.slotIntervalMinutes })) {
      if (t >= earliest) out.push(t);
    }
  }
  return out.sort((a, b) => a.toMillis() - b.toMillis());
}

/** A start is free if [start, start + duration + buffer) overlaps nothing busy. */
export function subtractBusy(
  candidates: DateTime[],
  durationMinutes: number,
  bufferMinutes: number,
  busy: Interval[],
): DateTime[] {
  return candidates.filter((t) => {
    const s = t.toMillis();
    const e = t.plus({ minutes: durationMinutes + bufferMinutes }).toMillis();
    return !busy.some((b) => b.start.getTime() < e && b.end.getTime() > s);
  });
}

/** ISO 8601 with the tenant's UTC offset, e.g. 2026-10-06T12:00:00-04:00. */
export function toTenantIso(t: DateTime, timezone: string): string {
  return t.setZone(timezone).toISO({ suppressMilliseconds: true })!;
}
