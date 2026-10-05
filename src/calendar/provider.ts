import type { Interval } from "../domain/availability.js";

export type CalendarEventInput = {
  summary: string;
  description: string;
  start: Date;
  end: Date;
  timeZone: string;
  /** Stored on the event so it can be traced back to the booking. */
  bookingId: string;
};

/**
 * Everything the app needs from a calendar. Today: one Google service account for all tenants.
 * Later: per-tenant OAuth can implement the same interface. Implementations throw CalendarError.
 */
export interface CalendarProvider {
  freeBusy(calendarIds: string[], timeMin: Date, timeMax: Date): Promise<Interval[]>;
  createEvent(calendarId: string, event: CalendarEventInput): Promise<{ id: string }>;
  /** Must treat an already-deleted event as success. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}
