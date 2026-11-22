// The user's own clock for the system prompt. The browser sends its time zone (an IANA name such
// as "America/Los_Angeles") with each message; without it the model only knows today's date in UTC
// and has to guess the zone from words like "Bay Area".

// The zone's name as given, or undefined when it is not a real zone. A bad value is
// ignored, never an error: the chat still works, with the UTC date.
export function validTimeZone(name: string | undefined | null): string | undefined {
  if (!name || name.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return undefined;
  }
}

export interface LocalTime {
  timeZone: string;
  // "2026-11-21" and "14:05" on the user's wall clock.
  date: string;
  time: string;
  // The zone's UTC offset at that moment, like "-08:00" ("+00:00" for UTC).
  offset: string;
}

export function localTime(now: Date, timeZone: string): LocalTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  // "GMT-08:00", or just "GMT" for UTC.
  const raw = get("timeZoneName").replace("GMT", "");
  return {
    timeZone,
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
    offset: raw === "" ? "+00:00" : raw.replace("−", "-"),
  };
}
