/** No usable Google token: run `npm run auth` (packages/calendar) to authorize. */
export class NotAuthorizedError extends Error {
  readonly code = "NOT_AUTHORIZED";
  readonly hint: string;
  constructor(message: string, hint = "Run `npm run auth` to connect Google Calendar.") {
    super(message);
    this.name = "NotAuthorizedError";
    this.hint = hint;
  }
}

/** A Calendar API call failed (after retries, for retryable statuses). */
export class CalendarApiError extends Error {
  readonly code: string = "CALENDAR_API_ERROR";
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "CalendarApiError";
  }
}

/**
 * The target calendar is not reachable. For a calendar the planner created that means it was deleted
 * and a new one is made; for a configured one (`CALENDAR_ID`) it means the id is wrong or the sharing
 * was withdrawn, and `message` says so instead.
 */
export class CalendarNotFoundError extends CalendarApiError {
  override readonly code = "CALENDAR_NOT_FOUND";
  constructor(
    readonly calendarId: string,
    message = `Calendar ${calendarId} not found (deleted externally?)`,
  ) {
    super(message, 404, "notFound");
    this.name = "CalendarNotFoundError";
  }
}
