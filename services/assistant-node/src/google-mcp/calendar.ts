// Google Calendar REST calls. Port of the working parts of the .NET CalendarConnector
// (primary calendar only).
import { googleRequest, type GoogleContext } from "./common.js";

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
}

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

export async function listEvents(ctx: GoogleContext, maxResults: number, now: Date = new Date()): Promise<CalendarEvent[]> {
  const query = new URLSearchParams({
    timeMin: now.toISOString(),
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
  });
  const body = await googleRequest<{ items?: GoogleEvent[] }>("Calendar", ctx, `${ctx.settings.urls.calendarEvents}?${query}`);
  return (body.items ?? []).map(toCalendarEvent);
}

export async function createEvent(
  ctx: GoogleContext,
  input: { summary: string; start: string; end: string; description?: string },
): Promise<CalendarEvent> {
  const created = await googleRequest<GoogleEvent>("Calendar", ctx, ctx.settings.urls.calendarEvents, {
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
