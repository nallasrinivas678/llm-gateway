// Google Calendar REST calls. Port of the working parts of the .NET CalendarConnector
// (primary calendar only).
import { googleRequest, type FetchFn } from "./common.js";

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
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
  const body = await googleRequest<{ items?: GoogleEvent[] }>("Calendar", fetchFn, `${EVENTS_URL}?${query}`, accessToken);
  return (body.items ?? []).map(toCalendarEvent);
}

export async function createEvent(
  accessToken: string,
  input: { summary: string; start: string; end: string; description?: string },
  fetchFn: FetchFn,
): Promise<CalendarEvent> {
  const created = await googleRequest<GoogleEvent>("Calendar", fetchFn, EVENTS_URL, accessToken, {
    method: "POST",
    body: {
      summary: input.summary,
      description: input.description,
      start: { dateTime: input.start },
      end: { dateTime: input.end },
    },
  });
  return toCalendarEvent(created);
}
