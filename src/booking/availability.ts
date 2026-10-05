import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import type { DateTime } from "luxon";
import type { CalendarProvider } from "../calendar/provider.js";
import type { Db, DbOrTx } from "../db/client.js";
import { bookings, type Tenant } from "../db/schema.js";
import { candidateStarts, dayBounds, subtractBusy, type Interval } from "../domain/availability.js";
import type { Selection } from "../domain/pricing.js";
import { CalendarError, calendarUnavailable } from "../lib/errors.js";

/** Bookings that currently hold time: confirmed, or pending a deposit with an unexpired hold. */
export function activeHoldFilter(now: Date) {
  return or(
    eq(bookings.status, "confirmed"),
    and(eq(bookings.status, "pending_deposit"), or(isNull(bookings.holdExpiresAt), gt(bookings.holdExpiresAt, now))),
  );
}

export async function bookedIntervals(db: DbOrTx, tenantId: string, range: Interval, now: Date): Promise<Interval[]> {
  const rows = await db
    .select({ start: bookings.startsAt, end: bookings.blockedUntil })
    .from(bookings)
    .where(and(eq(bookings.tenantId, tenantId), lt(bookings.startsAt, range.end), gt(bookings.blockedUntil, range.start), activeHoldFilter(now)));
  return rows;
}

export function calendarIdsFor(tenant: Tenant): string[] {
  if (!tenant.googleCalendarId) throw calendarUnavailable("This business hasn't connected a calendar yet.");
  return [...new Set([tenant.googleCalendarId, ...tenant.busyCalendarIds])];
}

/**
 * The single source of truth for open start times. Used by GET /availability and re-run
 * inside POST /bookings so a client can never book a start the server wouldn't offer.
 */
export async function openStarts(
  deps: { db: Db; calendar: CalendarProvider },
  tenant: Tenant,
  selection: Selection,
  date: string,
  now: Date,
): Promise<DateTime[]> {
  const candidates = candidateStarts(tenant, {
    date,
    durationMinutes: selection.totalDurationMinutes,
    minDaysNotice: selection.service.minDaysNotice,
    now,
  });
  if (!candidates.length) return [];

  const calendarIds = calendarIdsFor(tenant);
  // Widen the window so appointments/buffers crossing midnight are still seen.
  const day = dayBounds(date, tenant.timezone);
  const range = { start: new Date(day.start.getTime() - 86_400_000), end: new Date(day.end.getTime() + 86_400_000) };

  let googleBusy: Interval[];
  try {
    googleBusy = await deps.calendar.freeBusy(calendarIds, range.start, range.end);
  } catch (err) {
    if (err instanceof CalendarError) throw calendarUnavailable();
    throw err;
  }
  const booked = await bookedIntervals(deps.db, tenant.id, range, now);

  return subtractBusy(candidates, selection.totalDurationMinutes, tenant.bufferMinutes, [...booked, ...googleBusy]);
}

