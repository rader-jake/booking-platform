import { google, type calendar_v3 } from "googleapis";
import type { Interval } from "../domain/availability.js";
import { CalendarError } from "../lib/errors.js";
import type { CalendarEventInput, CalendarProvider } from "./provider.js";

const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const TIMEOUT_MS = 10_000;

/**
 * Google Calendar via one service account. Each tenant shares their calendar with the
 * service account's client_email ("Make changes to events").
 */
export class GoogleCalendarProvider implements CalendarProvider {
  private readonly calendar: calendar_v3.Calendar;

  constructor(serviceAccountJsonB64: string) {
    let creds: { client_email?: string; private_key?: string };
    try {
      creds = JSON.parse(Buffer.from(serviceAccountJsonB64, "base64").toString("utf8"));
    } catch {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not valid base64-encoded JSON");
    }
    if (!creds.client_email || !creds.private_key) {
      throw new Error("Service account JSON is missing client_email or private_key");
    }
    const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: SCOPES });
    this.calendar = google.calendar({ version: "v3", auth, timeout: TIMEOUT_MS });
  }

  async freeBusy(calendarIds: string[], timeMin: Date, timeMax: Date): Promise<Interval[]> {
    if (!calendarIds.length) return [];
    let res;
    try {
      res = await this.calendar.freebusy.query({
        requestBody: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          items: calendarIds.map((id) => ({ id })),
        },
      });
    } catch (err) {
      throw new CalendarError("freeBusy request failed", { cause: err });
    }
    const out: Interval[] = [];
    for (const id of calendarIds) {
      const cal = res.data.calendars?.[id];
      // Fail closed: if any calendar can't be read we can't know she's free.
      if (!cal || cal.errors?.length) {
        throw new CalendarError(`freeBusy could not read a calendar (${cal?.errors?.[0]?.reason ?? "missing"})`);
      }
      for (const b of cal.busy ?? []) {
        if (b.start && b.end) out.push({ start: new Date(b.start), end: new Date(b.end) });
      }
    }
    return out;
  }

  async createEvent(calendarId: string, event: CalendarEventInput): Promise<{ id: string }> {
    try {
      const res = await this.calendar.events.insert({
        calendarId,
        requestBody: {
          summary: event.summary,
          description: event.description,
          start: { dateTime: event.start.toISOString(), timeZone: event.timeZone },
          end: { dateTime: event.end.toISOString(), timeZone: event.timeZone },
          extendedProperties: { private: { bookingId: event.bookingId } },
        },
      });
      if (!res.data.id) throw new Error("no event id returned");
      return { id: res.data.id };
    } catch (err) {
      throw new CalendarError("createEvent failed", { cause: err });
    }
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.calendar.events.delete({ calendarId, eventId });
    } catch (err) {
      const status = (err as { code?: number; status?: number }).code ?? (err as { status?: number }).status;
      if (status === 404 || status === 410) return; // already gone
      throw new CalendarError("deleteEvent failed", { cause: err });
    }
  }
}
