import { describe, expect, it } from "vitest";
import { createWeather, describeWeatherCode, formatDay, weatherTool, type Forecast } from "./weatherTool.js";

const options = { geocodingUrl: "https://geo.example/search", forecastUrl: "https://forecast.example/v1", timeoutSeconds: 5, maxDays: 7 };

const place = { results: [{ name: "San Jose", admin1: "California", country: "United States", latitude: 37.34, longitude: -121.89 }] };
const daily = {
  daily: {
    time: ["2026-11-24", "2026-11-25"],
    temperature_2m_max: [18, 15.5],
    temperature_2m_min: [9, 7],
    precipitation_probability_max: [10, null],
    weather_code: [0, 63],
  },
};

function fakeFetch(routes: { match: string; body: unknown; status?: number }[]) {
  const urls: string[] = [];
  const fn = (async (url: string) => {
    urls.push(url);
    const route = routes.find((r) => url.includes(r.match));
    return new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fn, urls };
}

describe("describeWeatherCode", () => {
  it.each([
    [0, "clear"], [1, "mostly clear"], [2, "partly cloudy"], [3, "overcast"], [45, "fog"], [53, "drizzle"], [63, "rain"],
    [73, "snow"], [81, "rain showers"], [85, "snow showers"], [96, "thunderstorms"], [-1, "mixed"],
  ])("code %d is %s", (code, words) => expect(describeWeatherCode(code)).toBe(words));
});

describe("createWeather", () => {
  it("finds the place, then asks for its daily forecast, sending only the place name", async () => {
    const { fn, urls } = fakeFetch([{ match: "geo.example", body: place }, { match: "forecast.example", body: daily }]);
    const forecast = await createWeather(options, fn)("San Jose, CA");

    expect(new URL(urls[0]!).searchParams.get("name")).toBe("San Jose, CA");
    expect(new URL(urls[1]!).searchParams.get("latitude")).toBe("37.34");
    expect(new URL(urls[1]!).searchParams.get("forecast_days")).toBe("7");
    expect(forecast).toEqual({
      place: "San Jose, California, United States",
      days: [
        { date: "2026-11-24", highC: 18, lowC: 9, rainChance: 10, summary: "clear" },
        { date: "2026-11-25", highC: 15.5, lowC: 7, rainChance: null, summary: "rain" },
      ],
    });
  });

  it("returns null when no place matches", async () => {
    const { fn } = fakeFetch([{ match: "geo.example", body: {} }]);
    expect(await createWeather(options, fn)("Nowhereville")).toBeNull();
  });

  it("copes with a forecast that has no daily data", async () => {
    const { fn } = fakeFetch([{ match: "geo.example", body: place }, { match: "forecast.example", body: {} }]);
    expect((await createWeather(options, fn)("x"))?.days).toEqual([]);
  });

  it("throws on a failed request, without the response body", async () => {
    const { fn } = fakeFetch([{ match: "geo.example", body: { reason: "secret" }, status: 500 }]);
    await expect(createWeather(options, fn)("x")).rejects.toThrow("status 500");
  });
});

describe("formatDay", () => {
  it("writes the weekday, both temperature scales and the chance of rain", () => {
    expect(formatDay({ date: "2026-11-24", highC: 18, lowC: 9, rainChance: 10, summary: "clear" })).toBe(
      "Tue 2026-11-24: clear, high 64°F / 18°C, low 48°F / 9°C, 10% chance of rain",
    );
    expect(formatDay({ date: "2026-11-25", highC: 15.5, lowC: 7, rainChance: null, summary: "rain" })).not.toContain("chance");
  });
});

describe("weatherTool", () => {
  const forecast: Forecast = {
    place: "San Jose, California, United States",
    days: [
      { date: "2026-11-24", highC: 18, lowC: 9, rainChance: 10, summary: "clear" },
      { date: "2026-11-25", highC: 15, lowC: 7, rainChance: 70, summary: "rain" },
    ],
  };

  it("returns every day, or one date", async () => {
    const tool = weatherTool(async () => forecast, 7);
    expect(tool.name).toBe("get_weather");
    const all = String(await tool.invoke({ location: "San Jose" }));
    expect(all).toContain("San Jose, California");
    expect(all).toContain("2026-11-24");
    expect(all).toContain("2026-11-25");
    const one = String(await tool.invoke({ location: "San Jose", date: "2026-11-25" }));
    expect(one).toContain("rain");
    expect(one).not.toContain("2026-11-24");
  });

  it("says so when the place or the date is not covered", async () => {
    expect(await weatherTool(async () => null, 7).invoke({ location: "Nowhere" })).toMatch(/^The weather lookup failed: no place called "Nowhere"/);
    expect(await weatherTool(async () => forecast, 7).invoke({ location: "x1", date: "2027-01-01" })).toMatch(/covers 2026-11-24 to 2026-11-25/);
  });

  it("turns any failure into a readable message", async () => {
    const tool = weatherTool(async () => Promise.reject(new Error("socket hang up 10.0.0.1")), 7);
    const answer = String(await tool.invoke({ location: "San Jose" }));
    expect(answer).toMatch(/^The weather lookup failed/);
    expect(answer).not.toContain("10.0.0.1");
  });
});
