/** Every error response has the shape { error: { code, message, details? } }. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const slotTaken = () =>
  new AppError(409, "SLOT_TAKEN", "That time was just taken. Please pick another time.");
export const calendarUnavailable = (message = "The calendar is temporarily unavailable. Please try again shortly.") =>
  new AppError(503, "CALENDAR_UNAVAILABLE", message);

/** Thrown by CalendarProvider implementations; mapped to 503 at the edge. */
export class CalendarError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CalendarError";
  }
}
