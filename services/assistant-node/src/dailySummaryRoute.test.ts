import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { SummaryUnavailableError, type DailySummary, type DailySummaryService, type SummaryEvent } from "./dailySummary/dailySummaryService.js";

const secret = "test-secret-test-secret-test-secret-123";
const issuer = "https://example.supabase.co/auth/v1";
const config = loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWT_SECRET: secret });
const userId = "11111111-1111-1111-1111-111111111111";

const token = () =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer(issuer).setExpirationTime("5m").sign(new TextEncoder().encode(secret));

const result: DailySummary = {
  summary: "Calm day.",
  emails: [{ category: "bill", subject: "Power bill", from: "power@example.com", date: "2026-11-17T17:00:00.000Z" }],
  events: [{ summary: "Dentist", start: "2026-11-18T10:00:00-08:00", end: "2026-11-18T11:00:00-08:00" }],
  generatedAtUtc: "2026-11-18T08:00:00.000Z",
};

function fakeSummary(options: { events?: SummaryEvent[]; failWith?: unknown } = {}) {
  const users: string[] = [];
  const service = {
    build: async (user: string) => {
      users.push(user);
      if (options.failWith) throw options.failWith;
      return result;
    },
    async *stream(user: string) {
      users.push(user);
      for (const event of options.events ?? []) yield event;
      if (options.failWith) throw options.failWith;
    },
  } as unknown as DailySummaryService;
  return { service, users };
}

const get = async (app: ReturnType<typeof createApp>, path: string, withToken = true) =>
  app.request(path, { headers: withToken ? { authorization: `Bearer ${await token()}` } : {} });

// Reads an SSE body into [{ event, data }].
async function frames(response: Response) {
  return (await response.text())
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = Object.fromEntries(block.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
      return { event: lines.event, data: JSON.parse(lines.data) };
    });
}

describe("GET /assistant/daily-summary", () => {
  it("requires a login token", async () => {
    const { service } = fakeSummary();
    expect((await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary", false)).status).toBe(401);
  });

  it("returns the summary for the caller", async () => {
    const { service, users } = fakeSummary();
    const response = await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(users).toEqual([userId]);
  });

  it("answers 502 with the readable reason when the service gives one", async () => {
    const { service } = fakeSummary({ failWith: new SummaryUnavailableError("Google account is not connected. Please connect it first.") });
    const response = await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary");

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ detail: "Google account is not connected. Please connect it first." });
  });

  it("answers 502 with a generic message and no internal details for other failures", async () => {
    const { service } = fakeSummary({ failWith: new Error("db password is hunter2") });
    const response = await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary");

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });

  it("answers 503 when the summary is not configured", async () => {
    expect((await get(createApp(config), "/assistant/daily-summary")).status).toBe(503);
  });
});

describe("GET /assistant/daily-summary/stream", () => {
  it("requires a login token", async () => {
    const { service } = fakeSummary();
    expect((await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary/stream", false)).status).toBe(401);
  });

  it("writes status, chunk and done events with the .NET field names", async () => {
    const { service, users } = fakeSummary({
      events: [
        { type: "status", message: "Fetching your emails and calendar…" },
        { type: "chunk", text: "Calm " },
        { type: "chunk", text: "day." },
        { type: "done", result },
      ],
    });
    const response = await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary/stream");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await frames(response)).toEqual([
      { event: "status", data: { message: "Fetching your emails and calendar…" } },
      { event: "chunk", data: { text: "Calm " } },
      { event: "chunk", data: { text: "day." } },
      { event: "done", data: result },
    ]);
    expect(users).toEqual([userId]);
  });

  it("ends with an error event, with a safe message, when the stream fails", async () => {
    const { service } = fakeSummary({ events: [{ type: "status", message: "Writing your summary…" }], failWith: new Error("db password is hunter2") });
    const text = await (await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary/stream")).text();

    expect(text).toContain("event: error");
    expect(text).not.toContain("hunter2");
  });

  it("sends the readable reason in the error event when the service gives one", async () => {
    const { service } = fakeSummary({ failWith: new SummaryUnavailableError("Google account is not connected. Please connect it first.") });
    const all = await frames(await get(createApp(config, { dailySummary: service }), "/assistant/daily-summary/stream"));
    expect(all).toEqual([{ event: "error", data: { detail: "Google account is not connected. Please connect it first." } }]);
  });

  it("answers 503 when the summary is not configured", async () => {
    expect((await get(createApp(config), "/assistant/daily-summary/stream")).status).toBe(503);
  });
});
