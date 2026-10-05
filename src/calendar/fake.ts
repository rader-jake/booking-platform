import { randomUUID } from "node:crypto";
import type { Interval } from "../domain/availability.js";
import { CalendarError } from "../lib/errors.js";
import type { CalendarEventInput, CalendarProvider } from "./provider.js";

type Op = "freeBusy" | "createEvent" | "deleteEvent";

/** In-memory calendar for tests and local dev (CALENDAR_PROVIDER=fake). */
export class FakeCalendarProvider implements CalendarProvider {
  readonly events = new Map<string, Map<string, CalendarEventInput>>();
  private readonly busy = new Map<string, Interval[]>();
  private readonly failures = new Map<Op, number>();
  readonly calls: Record<Op, number> = { freeBusy: 0, createEvent: 0, deleteEvent: 0 };

  /** Simulate time blocked on the calendar for reasons other than bookings. */
  addBusy(calendarId: string, interval: Interval): void {
    this.busy.set(calendarId, [...(this.busy.get(calendarId) ?? []), interval]);
  }

  /** Make the next `times` calls to `op` throw. */
  failNext(op: Op, times = 1): void {
    this.failures.set(op, times);
  }

  eventsFor(calendarId: string): CalendarEventInput[] {
    return [...(this.events.get(calendarId)?.values() ?? [])];
  }

  private maybeFail(op: Op): void {
    this.calls[op]++;
    const left = this.failures.get(op) ?? 0;
    if (left > 0) {
      this.failures.set(op, left - 1);
      throw new CalendarError(`fake ${op} failure`);
    }
  }

  async freeBusy(calendarIds: string[], timeMin: Date, timeMax: Date): Promise<Interval[]> {
    this.maybeFail("freeBusy");
    const out: Interval[] = [];
    for (const id of calendarIds) {
      const intervals = [
        ...(this.busy.get(id) ?? []),
        ...[...(this.events.get(id)?.values() ?? [])].map((e) => ({ start: e.start, end: e.end })),
      ];
      out.push(...intervals.filter((i) => i.start < timeMax && i.end > timeMin));
    }
    return out;
  }

  async createEvent(calendarId: string, event: CalendarEventInput): Promise<{ id: string }> {
    this.maybeFail("createEvent");
    const id = randomUUID();
    if (!this.events.has(calendarId)) this.events.set(calendarId, new Map());
    this.events.get(calendarId)!.set(id, event);
    return { id };
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    this.maybeFail("deleteEvent");
    this.events.get(calendarId)?.delete(eventId);
  }
}
