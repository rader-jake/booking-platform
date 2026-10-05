import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, lte } from "drizzle-orm";
import { DateTime } from "luxon";
import type { FastifyBaseLogger } from "fastify";
import type { CalendarProvider } from "../calendar/provider.js";
import type { Db, Tx } from "../db/client.js";
import { bookingAddons, bookings, services, type Booking, type Tenant } from "../db/schema.js";
import { candidateStarts, toTenantIso } from "../domain/availability.js";
import type { Selection } from "../domain/pricing.js";
import { AppError, badRequest, CalendarError, calendarUnavailable, notFound, slotTaken } from "../lib/errors.js";
import type { Notifier } from "../notifications/index.js";
import { openStarts } from "./availability.js";
import { loadSelection } from "./catalog.js";

export type Deps = {
  db: Db;
  calendar: CalendarProvider;
  notifier: Notifier;
  log: FastifyBaseLogger;
  /** Waits between calendar delete retries on cancel. */
  calendarRetryDelaysMs?: number[];
};

export type NewBooking = {
  serviceKey: string;
  addonKeys: string[];
  startsAt: Date;
  name: string;
  email: string;
  phone: string;
  notes?: string;
};

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

function isOverlapViolation(err: unknown): boolean {
  for (let e = err as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === "23P01") return true;
  }
  return false;
}

function eventFor(tenant: Tenant, booking: Booking, selection: Pick<Selection, "service" | "addons">) {
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const lines = [
    `Service: ${selection.service.name}`,
    ...selection.addons.map((a) => `Add-on: ${a.name} (${money(a.priceCents)})`),
    `Total: ${money(booking.totalPriceCents)}`,
    booking.depositCents ? `Deposit: ${money(booking.depositCents)}` : null,
    "",
    `Client: ${booking.customerName}`,
    `Phone: ${booking.customerPhone}`,
    `Email: ${booking.customerEmail}`,
    booking.notes ? `Notes: ${booking.notes}` : null,
    "",
    `Booking ID: ${booking.id}`,
  ].filter((l) => l !== null);
  return {
    summary: `${selection.service.name} — ${booking.customerName}`,
    description: lines.join("\n"),
    start: booking.startsAt,
    end: booking.endsAt,
    timeZone: tenant.timezone,
    bookingId: booking.id,
  };
}

/**
 * Creates the calendar event inside the caller's transaction. If the calendar write fails the
 * transaction rolls back; if the transaction fails after the event exists, the event is removed.
 * Either way DB and calendar end up agreeing.
 */
async function withCalendarEvent<T>(
  deps: Deps,
  tenant: Tenant,
  work: (tx: Tx, attachEvent: (booking: Booking, sel: Pick<Selection, "service" | "addons">) => Promise<void>) => Promise<T>,
): Promise<T> {
  let createdEventId: string | null = null;
  const calendarId = tenant.googleCalendarId;
  try {
    return await deps.db.transaction(async (tx) =>
      work(tx, async (booking, sel) => {
        if (!calendarId) throw calendarUnavailable("This business hasn't connected a calendar yet.");
        const { id } = await deps.calendar.createEvent(calendarId, eventFor(tenant, booking, sel));
        createdEventId = id;
        await tx.update(bookings).set({ calendarEventId: id }).where(eq(bookings.id, booking.id));
      }),
    );
  } catch (err) {
    if (createdEventId && calendarId) {
      await deps.calendar.deleteEvent(calendarId, createdEventId).catch((e) =>
        deps.log.error({ eventId: createdEventId, err: (e as Error).message }, "orphaned calendar event after rollback; delete it manually"),
      );
    }
    if (err instanceof CalendarError) {
      throw calendarUnavailable("We couldn't save your appointment to the calendar, so it was not booked. Please try again.");
    }
    throw err;
  }
}

export async function createBooking(deps: Deps, tenant: Tenant, input: NewBooking, now: Date) {
  const selection = await loadSelection(deps.db, tenant.id, input.serviceKey, input.addonKeys);
  const date = DateTime.fromJSDate(input.startsAt, { zone: tenant.timezone }).toISODate()!;

  // Re-run the server's own availability for that day: the client can't pick a start we wouldn't offer.
  const open = await openStarts(deps, tenant, selection, date, now);
  if (!open.some((t) => t.toMillis() === input.startsAt.getTime())) {
    const candidates = candidateStarts(tenant, {
      date,
      durationMinutes: selection.totalDurationMinutes,
      minDaysNotice: selection.service.minDaysNotice,
      now,
    });
    if (candidates.some((t) => t.toMillis() === input.startsAt.getTime())) throw slotTaken();
    throw badRequest("INVALID_START", "That start time isn't available for this service.");
  }

  const endsAt = new Date(input.startsAt.getTime() + selection.totalDurationMinutes * 60_000);
  const blockedUntil = new Date(endsAt.getTime() + tenant.bufferMinutes * 60_000);
  const needsDeposit = !!tenant.depositCents && tenant.depositCents > 0;
  const cancelToken = randomBytes(32).toString("base64url");

  const booking = await withCalendarEvent(deps, tenant, async (tx, attachEvent) => {
    // Expired holds still match the exclusion constraint until their status changes.
    await tx
      .update(bookings)
      .set({ status: "expired" })
      .where(and(eq(bookings.tenantId, tenant.id), eq(bookings.status, "pending_deposit"), lte(bookings.holdExpiresAt, now)));

    let row: Booking;
    try {
      [row] = (await tx
        .insert(bookings)
        .values({
          tenantId: tenant.id,
          serviceId: selection.service.id,
          status: needsDeposit ? "pending_deposit" : "confirmed",
          startsAt: input.startsAt,
          endsAt,
          blockedUntil,
          totalPriceCents: selection.totalPriceCents,
          totalDurationMinutes: selection.totalDurationMinutes,
          depositCents: needsDeposit ? tenant.depositCents : null,
          holdExpiresAt: needsDeposit ? new Date(now.getTime() + tenant.depositHoldMinutes * 60_000) : null,
          customerName: input.name,
          customerEmail: input.email,
          customerPhone: input.phone,
          notes: input.notes || null,
          cancelTokenHash: hashToken(cancelToken),
        })
        .returning()) as [Booking];
    } catch (err) {
      if (isOverlapViolation(err)) throw slotTaken();
      throw err;
    }

    if (selection.addons.length) {
      await tx.insert(bookingAddons).values(
        selection.addons.map((a) => ({
          tenantId: tenant.id,
          bookingId: row.id,
          addonId: a.id,
          name: a.name,
          priceCents: a.priceCents,
          durationMinutes: a.durationMinutes,
        })),
      );
    }

    // Deposit tenants: the slot is held, but it only goes on the calendar once paid (confirmBooking).
    if (row.status === "confirmed") await attachEvent(row, selection);
    return row;
  });

  deps.notifier.bookingCreated(tenant.slug, booking).catch((e) => deps.log.warn({ err: (e as Error).message }, "notifier failed"));
  return { booking: await presentBooking(deps.db, tenant, booking), cancelToken };
}

/**
 * Phase 2 entry point (Square webhook): a paid deposit turns a hold into a confirmed booking and
 * writes the calendar event, atomically.
 * TODO(phase 2): decide what happens when payment lands after the hold expired and the slot was re-booked.
 */
export async function confirmBooking(deps: Deps, tenant: Tenant, bookingId: string) {
  const booking = await withCalendarEvent(deps, tenant, async (tx, attachEvent) => {
    const [row] = await tx
      .select()
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)))
      .for("update");
    if (!row) throw notFound("Booking");
    if (row.status === "confirmed") return row;
    if (row.status !== "pending_deposit") throw new AppError(409, "NOT_PENDING", `Booking is ${row.status}`);

    const [updated] = (await tx
      .update(bookings)
      .set({ status: "confirmed", holdExpiresAt: null })
      .where(eq(bookings.id, row.id))
      .returning()) as [Booking];
    const sel = await selectionForBooking(tx, updated);
    await attachEvent(updated, sel);
    return updated;
  });
  return presentBooking(deps.db, tenant, booking);
}

async function selectionForBooking(db: Db | Tx, booking: Booking) {
  const [service] = await db.select().from(services).where(eq(services.id, booking.serviceId));
  const addons = await db.select().from(bookingAddons).where(eq(bookingAddons.bookingId, booking.id));
  return {
    service: { ...service!, kind: "service" as const },
    addons: addons.map((a) => ({ id: a.addonId, key: "", kind: "addon" as const, name: a.name, priceCents: a.priceCents, durationMinutes: a.durationMinutes, minDaysNotice: 0 })),
  };
}

/** Public view of a booking. Deliberately omits customer PII. */
export async function presentBooking(db: Db | Tx, tenant: Tenant, b: Booking) {
  const sel = await selectionForBooking(db, b);
  const iso = (d: Date | null) => (d ? toTenantIso(DateTime.fromJSDate(d), tenant.timezone) : null);
  return {
    id: b.id,
    status: b.status,
    service: { id: sel.service.key, name: sel.service.name, priceCents: sel.service.priceCents },
    addons: sel.addons.map((a) => ({ name: a.name, priceCents: a.priceCents, durationMinutes: a.durationMinutes })),
    startsAt: iso(b.startsAt),
    endsAt: iso(b.endsAt),
    totalPriceCents: b.totalPriceCents,
    totalDurationMinutes: b.totalDurationMinutes,
    depositCents: b.depositCents,
    holdExpiresAt: iso(b.holdExpiresAt),
    // TODO(phase 2): Square payment link for pending_deposit bookings.
    depositUrl: null as string | null,
  };
}


const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tokenMatches(token: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cancels with the token issued at booking time. Wrong tenant, unknown id and wrong token all
 * look the same (404). The DB is updated first so the slot frees up immediately; the calendar
 * delete is retried, and if it still fails the booking is flagged calendar_sync_pending and
 * logged for reconciliation (the leftover event only over-blocks time, never double-books).
 */
export async function cancelBooking(deps: Deps, tenant: Tenant, bookingId: string, token: string, now: Date) {
  const [existing] = await deps.db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.tenantId, tenant.id)));
  if (!existing || !tokenMatches(token, existing.cancelTokenHash)) throw notFound("Booking");
  if (existing.status === "cancelled" || existing.status === "expired") return presentBooking(deps.db, tenant, existing);

  const [cancelled] = (await deps.db
    .update(bookings)
    .set({ status: "cancelled", cancelledAt: now })
    .where(and(eq(bookings.id, existing.id), eq(bookings.tenantId, tenant.id)))
    .returning()) as [Booking];

  if (cancelled.calendarEventId && tenant.googleCalendarId) {
    const delays = deps.calendarRetryDelaysMs ?? [250, 1000, 3000];
    let deleted = false;
    for (let attempt = 0; attempt <= delays.length && !deleted; attempt++) {
      try {
        await deps.calendar.deleteEvent(tenant.googleCalendarId, cancelled.calendarEventId);
        deleted = true;
      } catch (err) {
        deps.log.warn({ bookingId: cancelled.id, attempt: attempt + 1, err: (err as Error).message }, "calendar delete failed");
        if (attempt < delays.length) await sleep(delays[attempt]!);
      }
    }
    if (!deleted) {
      await deps.db.update(bookings).set({ calendarSyncPending: true }).where(eq(bookings.id, cancelled.id));
      cancelled.calendarSyncPending = true;
      deps.log.error({ bookingId: cancelled.id, tenant: tenant.slug }, "calendar delete failed after retries; booking flagged calendar_sync_pending");
    }
  }

  deps.notifier.bookingCancelled(tenant.slug, cancelled).catch((e) => deps.log.warn({ err: (e as Error).message }, "notifier failed"));
  return presentBooking(deps.db, tenant, cancelled);
}
