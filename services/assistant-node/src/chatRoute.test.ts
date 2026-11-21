import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ChatInput, ChatService } from "./chat/chatService.js";
import { ActionNotFoundError, ActionNotPendingError } from "./chat/approval.js";
import { ConversationNotFoundError } from "./chat/conversationStore.js";
import { loadConfig } from "./config.js";

const secret = "test-secret-test-secret-test-secret-123";
const issuer = "https://example.supabase.co/auth/v1";
const config = loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWT_SECRET: secret });
const userId = "11111111-1111-1111-1111-111111111111";

const token = () =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer(issuer).setExpirationTime("5m").sign(new TextEncoder().encode(secret));

function fakeChat(behaviour: (input: ChatInput) => Promise<unknown>) {
  const calls: ChatInput[] = [];
  const chat = {
    chat: async (input: ChatInput) => {
      calls.push(input);
      return behaviour(input);
    },
  } as unknown as ChatService;
  return { chat, calls };
}

async function post(app: ReturnType<typeof createApp>, body: unknown, withToken = true) {
  return app.request("/assistant/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...(withToken ? { authorization: `Bearer ${await token()}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const ok = async () => ({ conversationId: "c-1", reply: "Hi!", toolCallsExecuted: [] });

describe("POST /assistant/chat", () => {
  it("requires a login token", async () => {
    const { chat } = fakeChat(ok);
    expect((await post(createApp(config, { chat }), { message: "hi" }, false)).status).toBe(401);
  });

  it("returns the same shape as the .NET endpoint and passes the caller's identity on", async () => {
    const { chat, calls } = fakeChat(ok);
    const response = await post(createApp(config, { chat }), { message: "  hello  " });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversationId: "c-1", reply: "Hi!", toolCallsExecuted: [] });
    expect(calls[0]).toMatchObject({ userId, message: "hello", conversationId: undefined });
    expect(calls[0]?.jwt.split(".")).toHaveLength(3);
  });

  it("passes an existing conversation id on", async () => {
    const { chat, calls } = fakeChat(ok);
    const id = "3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b";
    await post(createApp(config, { chat }), { conversationId: id, message: "again" });
    expect(calls[0]?.conversationId).toBe(id);
  });

  it("accepts a null conversation id (a new conversation)", async () => {
    const { chat } = fakeChat(ok);
    expect((await post(createApp(config, { chat }), { conversationId: null, message: "hi" })).status).toBe(200);
  });

  it.each([
    ["an empty message", { message: "   " }],
    ["a missing message", {}],
    ["a message that is too long", { message: "x".repeat(config.settings.chat.maxMessageLength + 1) }],
    ["a conversation id that is not a UUID", { conversationId: "abc", message: "hi" }],
    ["a body that is not JSON", "not json"],
  ])("rejects %s with 400 without calling the assistant", async (_label, body) => {
    const { chat, calls } = fakeChat(ok);
    expect((await post(createApp(config, { chat }), body)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("answers 404 for a conversation that is not the caller's", async () => {
    const { chat } = fakeChat(async () => {
      throw new ConversationNotFoundError();
    });
    const response = await post(createApp(config, { chat }), { conversationId: "3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b", message: "hi" });
    expect(response.status).toBe(404);
  });

  it("answers 502 with a generic message and no internal details when something breaks", async () => {
    const { chat } = fakeChat(async () => {
      throw new Error("db password is hunter2");
    });
    const response = await post(createApp(config, { chat }), { message: "hi" });

    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("hunter2");
  });

  it("answers 504 when the assistant takes too long", async () => {
    const { chat } = fakeChat(async () => {
      throw Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    });
    const response = await post(createApp(config, { chat }), { message: "hi" });
    expect(response.status).toBe(504);
    expect((await response.json()).error).toContain("too long");
  });

  it("limits each user to the configured number of messages a minute", async () => {
    const { chat, calls } = fakeChat(ok);
    const app = createApp(config, { chat });
    for (let i = 0; i < config.settings.chat.requestsPerMinute; i++) expect((await post(app, { message: "hi" })).status).toBe(200);

    const limited = await post(app, { message: "hi" });
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toContain("Too many");
    expect(calls).toHaveLength(config.settings.chat.requestsPerMinute);
  });

  it("answers 503 when chat is not configured", async () => {
    expect((await post(createApp(config), { message: "hi" })).status).toBe(503);
  });
});

describe("saved conversations routes", () => {
  const id = "3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b";
  const summary = { id, title: "Plan my week", createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-20T01:00:00Z" };

  function fakeConversations(fail?: Error) {
    const calls: { op: string; userId: string; jwt: string; id?: string }[] = [];
    const run = async <T>(op: string, userId: string, jwt: string, value: T, conversationId?: string) => {
      calls.push({ op, userId, jwt, id: conversationId });
      if (fail) throw fail;
      return value;
    };
    const chat = {
      list: (userId: string, jwt: string) => run("list", userId, jwt, [summary]),
      get: (userId: string, jwt: string, cid: string) => run("get", userId, jwt, { id: cid, title: "Plan my week", messages: [{ role: "user", text: "hi", tools: [] }] }, cid),
      remove: (userId: string, jwt: string, cid: string) => run("remove", userId, jwt, undefined, cid),
    } as unknown as ChatService;
    return { chat, calls };
  }

  const call = async (app: ReturnType<typeof createApp>, method: string, path: string, withToken = true) =>
    app.request(path, { method, headers: withToken ? { authorization: `Bearer ${await token()}` } : {} });

  it("requires a login token", async () => {
    const { chat } = fakeConversations();
    expect((await call(createApp(config, { chat }), "GET", "/assistant/conversations", false)).status).toBe(401);
  });

  it("lists the caller's conversations as the caller", async () => {
    const { chat, calls } = fakeConversations();
    const response = await call(createApp(config, { chat }), "GET", "/assistant/conversations");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ conversations: [summary] });
    expect(calls[0]).toMatchObject({ op: "list", userId });
    expect(calls[0]?.jwt.split(".")).toHaveLength(3);
  });

  it("returns one conversation's messages", async () => {
    const { chat, calls } = fakeConversations();
    const response = await call(createApp(config, { chat }), "GET", `/assistant/conversations/${id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, title: "Plan my week", messages: [{ role: "user", text: "hi", tools: [] }] });
    expect(calls[0]).toMatchObject({ op: "get", userId, id });
  });

  it("deletes a conversation with 204", async () => {
    const { chat, calls } = fakeConversations();
    const response = await call(createApp(config, { chat }), "DELETE", `/assistant/conversations/${id}`);
    expect(response.status).toBe(204);
    expect(calls[0]).toMatchObject({ op: "remove", userId, id });
  });

  it.each(["GET", "DELETE"])("%s answers 404 for an id that is not a UUID, without touching the store", async (method) => {
    const { chat, calls } = fakeConversations();
    expect((await call(createApp(config, { chat }), method, "/assistant/conversations/abc")).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each(["GET", "DELETE"])("%s answers 404 for a conversation that is not the caller's", async (method) => {
    const { chat } = fakeConversations(new ConversationNotFoundError());
    const response = await call(createApp(config, { chat }), method, `/assistant/conversations/${id}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Conversation not found." });
  });

  it("answers 502 with a plain message when the database fails, and never shows its message", async () => {
    const { chat } = fakeConversations(new Error("relation secret_table does not exist"));
    const response = await call(createApp(config, { chat }), "GET", "/assistant/conversations");
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret_table");
  });

  it.each([
    ["GET", "/assistant/conversations"],
    ["GET", `/assistant/conversations/${id}`],
    ["DELETE", `/assistant/conversations/${id}`],
  ])("%s %s answers 503 when chat is not configured", async (method, path) => {
    expect((await call(createApp(config, {}), method, path)).status).toBe(503);
  });
});

describe("approve and reject routes", () => {
  const id = "3f2b8c1e-5a4d-4e6f-8b7a-9c0d1e2f3a4b";

  function fakeDecisions(fail?: Error) {
    const calls: { op: string; userId: string; jwt: string; id: string }[] = [];
    const decide = (op: string, status: "done" | "rejected") => async (userId: string, jwt: string, actionId: string) => {
      calls.push({ op, userId, jwt, id: actionId });
      if (fail) throw fail;
      return { id: actionId, status, result: status === "done" ? "Created the task." : null };
    };
    const chat = { approve: decide("approve", "done"), reject: decide("reject", "rejected") } as unknown as ChatService;
    return { chat, calls };
  }

  const call = async (app: ReturnType<typeof createApp>, path: string, withToken = true) =>
    app.request(path, { method: "POST", headers: withToken ? { authorization: `Bearer ${await token()}` } : {} });

  it("requires a login token", async () => {
    const { chat } = fakeDecisions();
    expect((await call(createApp(config, { chat }), `/assistant/actions/${id}/approve`, false)).status).toBe(401);
  });

  it("approves as the caller and returns the outcome", async () => {
    const { chat, calls } = fakeDecisions();
    const response = await call(createApp(config, { chat }), `/assistant/actions/${id}/approve`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, status: "done", result: "Created the task." });
    expect(calls[0]).toMatchObject({ op: "approve", userId, id });
    expect(calls[0]?.jwt.split(".")).toHaveLength(3);
  });

  it("rejects as the caller", async () => {
    const { chat, calls } = fakeDecisions();
    const response = await call(createApp(config, { chat }), `/assistant/actions/${id}/reject`);
    expect(await response.json()).toEqual({ id, status: "rejected", result: null });
    expect(calls[0]).toMatchObject({ op: "reject", userId, id });
  });

  it.each(["approve", "reject"])("%s answers 404 for an id that is not a UUID, without touching the store", async (verb) => {
    const { chat, calls } = fakeDecisions();
    expect((await call(createApp(config, { chat }), `/assistant/actions/abc/${verb}`)).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it.each(["approve", "reject"])("%s answers 404 for an action that is not the caller's", async (verb) => {
    const { chat } = fakeDecisions(new ActionNotFoundError());
    const response = await call(createApp(config, { chat }), `/assistant/actions/${id}/${verb}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Action not found." });
  });

  it.each([
    ["done", "This change was already done."],
    ["rejected", "This change was already rejected."],
    ["running", "This change was already running."],
    ["expired", "This change expired. Ask the assistant again."],
  ])("answers 409 for a change that is %s", async (status, message) => {
    const { chat } = fakeDecisions(new ActionNotPendingError(status));
    const response = await call(createApp(config, { chat }), `/assistant/actions/${id}/approve`);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: message });
  });

  it("answers 502 with a plain message when the database fails, and never shows its message", async () => {
    const { chat } = fakeDecisions(new Error("relation secret_table does not exist"));
    const response = await call(createApp(config, { chat }), `/assistant/actions/${id}/approve`);
    expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret_table");
  });

  it("answers 503 when chat is not configured", async () => {
    expect((await call(createApp(config, {}), `/assistant/actions/${id}/approve`)).status).toBe(503);
  });
});
