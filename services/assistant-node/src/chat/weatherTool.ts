// Weather for the chat: Open-Meteo (no key). One request finds the place, a second gets the daily
// forecast. Only the place name the model typed leaves the service, never anything about the user.
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";

export interface WeatherOptions {
  geocodingUrl: string;
  forecastUrl: string;
  timeoutSeconds: number;
  maxDays: number;
}

export interface WeatherDay {
  date: string;
  highC: number;
  lowC: number;
  rainChance: number | null;
  summary: string;
}

export interface Forecast {
  place: string;
  days: WeatherDay[];
}

export type WeatherFn = (location: string) => Promise<Forecast | null>;

// WMO weather codes, as Open-Meteo reports them, in plain words.
export function describeWeatherCode(code: number): string {
  if (code === 0) return "clear";
  if (code === 1) return "mostly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorms";
  return "mixed";
}

interface GeocodingResponse {
  results?: { name: string; admin1?: string; country?: string; latitude: number; longitude: number }[];
}

interface ForecastResponse {
  daily?: {
    time?: string[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: (number | null)[];
    weather_code?: number[];
  };
}

export function createWeather(options: WeatherOptions, fetchFn: typeof fetch = fetch): WeatherFn {
  const get = async <T>(url: string): Promise<T> => {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(options.timeoutSeconds * 1000) });
    if (!response.ok) throw new Error(`Weather request failed with status ${response.status}.`);
    return (await response.json()) as T;
  };

  return async (location) => {
    const place = (await get<GeocodingResponse>(`${options.geocodingUrl}?${new URLSearchParams({ name: location, count: "1", language: "en", format: "json" })}`)).results?.[0];
    if (!place) return null;

    const forecast = await get<ForecastResponse>(
      `${options.forecastUrl}?${new URLSearchParams({
        latitude: String(place.latitude),
        longitude: String(place.longitude),
        daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
        timezone: "auto",
        forecast_days: String(options.maxDays),
      })}`,
    );
    const daily = forecast.daily;
    const days: WeatherDay[] = (daily?.time ?? []).map((date, i) => ({
      date,
      highC: daily?.temperature_2m_max?.[i] ?? NaN,
      lowC: daily?.temperature_2m_min?.[i] ?? NaN,
      rainChance: daily?.precipitation_probability_max?.[i] ?? null,
      summary: describeWeatherCode(daily?.weather_code?.[i] ?? -1),
    }));
    const name = [place.name, place.admin1, place.country].filter(Boolean).join(", ");
    return { place: name, days };
  };
}

const toF = (celsius: number) => Math.round((celsius * 9) / 5 + 32);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatDay(day: WeatherDay): string {
  const weekday = WEEKDAYS[new Date(`${day.date}T12:00:00Z`).getUTCDay()];
  const rain = day.rainChance === null ? "" : `, ${day.rainChance}% chance of rain`;
  return `${weekday} ${day.date}: ${day.summary}, high ${toF(day.highC)}°F / ${Math.round(day.highC)}°C, low ${toF(day.lowC)}°F / ${Math.round(day.lowC)}°C${rain}`;
}

export function weatherTool(weather: WeatherFn, maxDays: number): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: "get_weather",
    description: `Weather forecast for a place for up to the next ${maxDays} days, or for one date. Pass only a place name (like "San Jose, CA"); never anything about the user. Not for past dates.`,
    schema: z.object({
      location: z.string().min(2).max(100).describe("A city or place name, like 'San Jose, CA'"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("One date (YYYY-MM-DD) to look up; leave out for all days"),
    }),
    func: async ({ location, date }) => {
      try {
        const forecast = await weather(location);
        if (!forecast) return `The weather lookup failed: no place called "${location}" was found. Ask the user for a clearer place name.`;
        const days = date ? forecast.days.filter((d) => d.date === date) : forecast.days;
        if (days.length === 0) {
          const first = forecast.days[0]?.date;
          const last = forecast.days[forecast.days.length - 1]?.date;
          return `The weather lookup failed: no forecast for ${date}. The forecast covers ${first} to ${last}.`;
        }
        return `${forecast.place}\n${days.map(formatDay).join("\n")}`;
      } catch {
        return "The weather lookup failed. Tell the user the weather is unavailable right now.";
      }
    },
  });
}
