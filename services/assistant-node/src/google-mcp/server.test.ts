import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { loadSettings } from "../config.js";
import type { FetchFn } from "./common.js";
import { createGoogleMcpServer } from "./server.js";

interface Call {
  url: string;
  init?: RequestInit;
}

// A fake Google: answers each request from the first route whose text appears in the URL.
function fakeGoogle(routes: { match: string; status?: number; body: unknown }[]) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const route = routes.find((r) => String(url).includes(r.match));
    return new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? (route ? 200 : 404) });
  }) as FetchFn;
  return { calls, fetchFn };
}
const single = (body: unknown, status = 200) => fakeGoogle([{ match: "", status, body }]);

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
const authOf = (call?: Call) => (call?.init?.headers as Record<string, string>).Authorization;

describe("google-mcp server", () => {
  it("lists all tools", async () => {
    const client = await connect("t", single({}).fetchFn);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "append_to_doc",
      "create_draft",
      "create_event",
      "list_events",
      "read_doc",
      "search_emails",
    ]);
  });

  it("does not offer a way to send email", async () => {
    const client = await connect("t", single({}).fetchFn);
    const { tools } = await client.listTools();
    expect(tools.some((t) => /send/i.test(t.name))).toBe(false);
  });

  it("keeps each user's token separate", async () => {
    const google = single({ items: [] });
    const alice = await connect("token-alice", google.fetchFn);
    const bob = await connect("token-bob", google.fetchFn);

    await alice.callTool({ name: "list_events", arguments: {} });
    await bob.callTool({ name: "list_events", arguments: {} });

    expect(google.calls.map(authOf)).toEqual(["Bearer token-alice", "Bearer token-bob"]);
  });

  it("turns a Google error into a readable tool error without leaking the response body", async () => {
    const client = await connect("t", single({ error: "secret-detail" }, 401).fetchFn);

    const result = await client.callTool({ name: "list_events", arguments: {} });

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("reconnect");
    expect(firstText(result)).not.toContain("secret-detail");
  });
});

describe("calendar tools", () => {
  it("lists events with the caller's token and handles all-day events", async () => {
    const google = single({
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
    expect(authOf(google.calls[0])).toBe("Bearer token-alice");
  });

  it("creates an event", async () => {
    const google = single({
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
    const google = single({});
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({
      name: "create_event",
      arguments: { summary: "Bad", start: "2026-11-20T16:00:00Z", end: "2026-11-20T15:00:00Z" },
    });

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("rejects an invalid date", async () => {
    const google = single({});
    const client = await connect("t", google.fetchFn);

    const result = await client
      .callTool({ name: "create_event", arguments: { summary: "x", start: "tomorrow", end: "later" } })
      .catch(() => ({ isError: true }));

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });
});

describe("gmail tools", () => {
  it("searches and returns subject, sender, date and snippet", async () => {
    const google = fakeGoogle([
      { match: "/messages?", body: { messages: [{ id: "m1" }, { id: "m2" }] } },
      {
        match: "/messages/m1",
        body: { id: "m1", snippet: "Your order shipped", payload: { headers: [{ name: "subject", value: "Order shipped" }, { name: "From", value: "shop@example.com" }, { name: "Date", value: "Mon, 16 Nov 2026" }] } },
      },
      { match: "/messages/m2", body: { id: "m2", snippet: "Bill due", payload: { headers: [{ name: "Subject", value: "Bill" }] } } },
    ]);
    const client = await connect("token-alice", google.fetchFn);

    const result = await client.callTool({ name: "search_emails", arguments: { query: "subject:order newer_than:14d", maxResults: 2 } });

    expect(JSON.parse(firstText(result))).toEqual([
      { id: "m1", subject: "Order shipped", from: "shop@example.com", date: "Mon, 16 Nov 2026", snippet: "Your order shipped" },
      { id: "m2", subject: "Bill", from: "", date: "", snippet: "Bill due" },
    ]);
    expect(google.calls[0]?.url).toContain("maxResults=2");
    expect(new URL(google.calls[0]?.url ?? "").searchParams.get("q")).toBe("subject:order newer_than:14d");
    expect(google.calls.every((c) => authOf(c) === "Bearer token-alice")).toBe(true);
  });

  it("returns an empty list when nothing matches", async () => {
    const client = await connect("t", single({}).fetchFn);
    const result = await client.callTool({ name: "search_emails", arguments: { query: "nothing" } });
    expect(JSON.parse(firstText(result))).toEqual([]);
  });

  it("creates a draft with an encoded message and says it was not sent", async () => {
    const google = single({ id: "draft-1" });
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({
      name: "create_draft",
      arguments: { to: "bob@example.com", subject: "Héllo", body: "Hi Bob" },
    });

    expect(firstText(result)).toContain("not been sent");
    expect(google.calls[0]?.url).toContain("/drafts");
    const raw = JSON.parse(String(google.calls[0]?.init?.body)).message.raw as string;
    const message = Buffer.from(raw, "base64url").toString("utf8");
    expect(message).toContain("To: bob@example.com");
    expect(message).toContain("=?UTF-8?B?");                       // non-ASCII subject is encoded
    expect(message).toContain(Buffer.from("Hi Bob").toString("base64"));
  });

  it("refuses line breaks in the subject so headers cannot be injected", async () => {
    const google = single({ id: "draft-1" });
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({
      name: "create_draft",
      arguments: { to: "bob@example.com", subject: "Hi\r\nBcc: attacker@example.com", body: "x" },
    });

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("refuses an invalid recipient address", async () => {
    const google = single({});
    const client = await connect("t", google.fetchFn);

    const result = await client
      .callTool({ name: "create_draft", arguments: { to: "not-an-email", subject: "s", body: "b" } })
      .catch(() => ({ isError: true }));

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });
});

describe("docs tools", () => {
  const documentId = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

  it("reads the title and text of a document", async () => {
    const google = single({
      title: "Notes",
      body: { content: [{ sectionBreak: {} }, { paragraph: { elements: [{ textRun: { content: "Hello " } }, { textRun: { content: "world\n" } }] } }] },
    });
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({ name: "read_doc", arguments: { documentId } });

    expect(JSON.parse(firstText(result))).toEqual({ title: "Notes", text: "Hello world\n", truncated: false });
    expect(google.calls[0]?.url).toBe(`https://docs.googleapis.com/v1/documents/${documentId}`);
  });

  it("truncates very long documents", async () => {
    const long = "a".repeat(25_000);
    const client = await connect("t", single({ title: "Big", body: { content: [{ paragraph: { elements: [{ textRun: { content: long } }] } }] } }).fetchFn);

    const result = JSON.parse(firstText(await client.callTool({ name: "read_doc", arguments: { documentId } })));

    expect(result.text).toHaveLength(20_000);
    expect(result.truncated).toBe(true);
  });

  it("appends text to the end of the document body", async () => {
    const google = single({});
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({ name: "append_to_doc", arguments: { documentId, text: "New line" } });

    expect(result.isError).toBeFalsy();
    expect(google.calls[0]?.url).toBe(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`);
    expect(JSON.parse(String(google.calls[0]?.init?.body))).toEqual({
      requests: [{ insertText: { text: "New line", endOfSegmentLocation: {} } }],
    });
  });

  it("refuses a document id that could change the request path", async () => {
    const google = single({});
    const client = await connect("t", google.fetchFn);

    const result = await client.callTool({ name: "read_doc", arguments: { documentId: "../../drive/v3/files/abcdefghij" } });

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });
});

describe("settings are used, not hardcoded", () => {
  const custom = () => {
    const settings = structuredClone(loadSettings().google);
    settings.urls.calendarEvents = "https://calendar.test.example/events";
    settings.urls.docsDocuments = "https://docs.test.example/documents";
    settings.limits.calendar.maxEvents = 3;
    settings.limits.calendar.defaultEvents = 2;
    settings.limits.docs.maxReadChars = 5;
    return settings;
  };

  async function connectWith(settings: ReturnType<typeof custom>, fetchFn: FetchFn) {
    const server = createGoogleMcpServer("t", { fetch: fetchFn, settings });
    const client = new Client({ name: "test", version: "0" });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return client;
  }

  it("calls the configured URL and uses the configured default", async () => {
    const google = single({ items: [] });
    const client = await connectWith(custom(), google.fetchFn);

    await client.callTool({ name: "list_events", arguments: {} });

    expect(google.calls[0]?.url.startsWith("https://calendar.test.example/events?")).toBe(true);
    expect(google.calls[0]?.url).toContain("maxResults=2");
  });

  it("enforces the configured maximum", async () => {
    const google = single({ items: [] });
    const client = await connectWith(custom(), google.fetchFn);

    const result = await client.callTool({ name: "list_events", arguments: { maxResults: 4 } }).catch(() => ({ isError: true }));

    expect(result.isError).toBe(true);
    expect(google.calls).toHaveLength(0);
  });

  it("truncates documents at the configured length", async () => {
    const documentId = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
    const google = single({ title: "T", body: { content: [{ paragraph: { elements: [{ textRun: { content: "abcdefghij" } }] } }] } });
    const client = await connectWith(custom(), google.fetchFn);

    const result = JSON.parse(firstText(await client.callTool({ name: "read_doc", arguments: { documentId } })));

    expect(google.calls[0]?.url).toBe(`https://docs.test.example/documents/${documentId}`);
    expect(result).toEqual({ title: "T", text: "abcde", truncated: true });
  });
});
