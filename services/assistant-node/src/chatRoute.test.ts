import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { ChatInput, ChatService } from "./chat/chatService.js";
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
