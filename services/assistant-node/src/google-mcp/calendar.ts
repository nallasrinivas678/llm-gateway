// Google Calendar REST calls, kept free of MCP so they are easy to test and reuse.
// Port of the working parts of the .NET CalendarConnector (primary calendar only).

export type FetchFn = typeof fetch;

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
}

export class GoogleApiError extends Error {
  constructor(readonly status: number) {
    super(`Google API request failed with status ${status}`);
  }
}

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

interface GoogleEvent {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

// All-day events only have `date`; the .NET connector read `dateTime` only and got those wrong.
function toCalendarEvent(event: GoogleEvent): CalendarEvent {
  return {
    summary: event.summary ?? "(no title)",
    start: event.start?.dateTime ?? event.start?.date ?? "",
    end: event.end?.dateTime ?? event.end?.date ?? "",
  };
}

export async function listEvents(
  accessToken: string,
  maxResults: number,
  fetchFn: FetchFn,
  now: Date = new Date(),
): Promise<CalendarEvent[]> {
  const query = new URLSearchParams({
    timeMin: now.toISOString(),
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const response = await fetchFn(`${EVENTS_URL}?${query}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new GoogleApiError(response.status);

  const body = (await response.json()) as { items?: GoogleEvent[] };
  return (body.items ?? []).map(toCalendarEvent);
}

export async function createEvent(
  accessToken: string,
  input: { summary: string; start: string; end: string; description?: string },
  fetchFn: FetchFn,
): Promise<CalendarEvent> {
  const response = await fetchFn(EVENTS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
    }),
  });
  if (!response.ok) throw new GoogleApiError(response.status);

  return toCalendarEvent((await response.json()) as GoogleEvent);
}
