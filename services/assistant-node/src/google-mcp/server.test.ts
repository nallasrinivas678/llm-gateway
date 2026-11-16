import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { FetchFn } from "./calendar.js";
import { createGoogleMcpServer } from "./server.js";

interface Call {
  url: string;
  init?: RequestInit;
}

function fakeGoogle(status: number, body: unknown) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status });
  }) as FetchFn;
  return { calls, fetchFn };
}

// Connects a real MCP client to the server in memory, the way the agent will call it.
async function connect(token: string, fetchFn: FetchFn) {
  const server = createGoogleMcpServer(token, { fetch: fetchFn });
  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const firstText = (result: unknown) =>
  ((result as { content: { text: string }[] }).content[0] as { text: string }).text;

describe("google-mcp calendar tools", () => {
  it("lists the tools", async () => {
    const client = await connect("t", fakeGoogle(200, {}).fetchFn);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_event", "list_events"]);
  });

  it("lists events with the caller's token and handles all-day events", async () => {
    const google = fakeGoogle(200, {
      items: [
        { summary: "Standup", start: { dateTime: "2026-11-17T09:00:00Z" }, end: { dateTime: "2026-11-17T09:15:00Z" } },
        { summary: "Holiday", start: { date: "2026-11-26" }, end: { date: "2026-11-27" } },
      ],
    });
    const client = await connect("token-alice", google.fetchFn);

    const result = await client.callTool({ name: "list_events", arguments: { maxResults: 5 } });

    expect(JSON.parse(firstText(result))).toEqual([
      { summary: "Standup", start: "2026-11-17T09:00:00Z", end: "2026-11-17T09:15:00Z" },
      { summary: "Holiday", start: "2026-11-26", end: "2026-11-27" },
    ]);
    expect(google.calls[0]?.url).toContain("maxResults=5");
    expect((google.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer token-alice");
  });

  it("keeps each user's token separate", async () => {
    const google = fakeGoogle(200, { items: [] });
    const alice = await connect("token-alice", google.fetchFn);
    const bob = await connect("token-bob", google.fetchFn);

    await alice.callTool({ name: "list_events", arguments: {} });
    await bob.callTool({ name: "list_events", arguments: {} });

    const used = google.calls.map((c) => (c.init?.headers as Record<string, string>).Authorization);
    expect(used).toEqual(["Bearer token-alice", "Bearer token-bob"]);
  });

  it("creates an event", async () => {
    const google = fakeGoogle(200, {
      summary: "Dentist",
      start: { dateTime: "2026-11-20T15:00:00-08:00" },
      end: { dateTime: "2026-11-20T16:00:00-08:00" },
    });
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({
      name: "create_event",
      arguments: { summary: "Dentist", start: "2026-11-20T15:00:00-08:00", end: "2026-11-20T16:00:00-08:00" },
    });

    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain("Dentist");
    expect(google.calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(google.calls[0]?.init?.body)).start).toEqual({ dateTime: "2026-11-20T15:00:00-08:00" });
  });

  it("rejects an event that ends before it starts, without calling Google", async () => {
    const google = fakeGoogle(200, {});
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({
      name: "create_event",
      arguments: { summary: "Bad", start: "2026-11-20T16:00:00Z", end: "2026-11-20T15:00:00Z" },
    });

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("rejects invalid input", async () => {
    const google = fakeGoogle(200, {});
    const client = await connect("t", google.fetchFn);

    const result = await client
      .callTool({ name: "create_event", arguments: { summary: "x", start: "tomorrow", end: "later" } })
      .catch(() => ({ isError: true }));

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("turns a Google error into a readable tool error without leaking the response body", async () => {
    const client = await connect("t", fakeGoogle(401, { error: "secret-detail" }).fetchFn);

    const result = await client.callTool({ name: "list_events", arguments: {} });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("reconnect");
    expect(firstText(result)).not.toContain("secret-detail");
  });
});
