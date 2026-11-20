import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AskService } from "./docQa/ask.js";
import { DocBusyError, DocNotFoundError, DocNotReadyError } from "./docQa/errors.js";
import type { IngestService } from "./docQa/ingest.js";

const secret = "test-secret-test-secret-test-secret-123";
const issuer = "https://example.supabase.co/auth/v1";
const config = loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWT_SECRET: secret });
const userId = "11111111-1111-1111-1111-111111111111";
const documentId = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

const token = () =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer(issuer).setExpirationTime("5m").sign(new TextEncoder().encode(secret));

function services(overrides: { ingest?: Partial<IngestService>; ask?: Partial<AskService> } = {}) {
  return {
    docQa: {
      ingest: { start: vi.fn(async () => ({ done: Promise.resolve() })), ...overrides.ingest } as IngestService,
      ask: { ask: vi.fn(async () => ({ answer: "Sixty days (p. 3).", sources: [{ page: 3, snippet: "s" }] })), ...overrides.ask } as AskService,
    },
  };
}

async function post(app: ReturnType<typeof createApp>, path: string, body: unknown, withToken = true) {
  const headers = new Headers({ "content-type": "application/json" });
  if (withToken) headers.set("authorization", `Bearer ${await token()}`);
  return app.request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("PDF Q&A routes", () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => error.mockRestore());

  it("needs a login", async () => {
    const app = createApp(config, services());
    expect((await post(app, "/assistant/docs", { documentId }, false)).status).toBe(401);
    expect((await post(app, "/assistant/docs/ask", { documentId, question: "Q?" }, false)).status).toBe(401);
  });

  it("answers 503 when PDF Q&A is not configured", async () => {
    const app = createApp(config, {});
    expect((await post(app, "/assistant/docs", { documentId })).status).toBe(503);
    expect((await post(app, "/assistant/docs/ask", { documentId, question: "Q?" })).status).toBe(503);
  });

  describe("POST /assistant/docs", () => {
    it("starts ingest as the caller and returns 202", async () => {
      const s = services();
      const response = await post(createApp(config, s), "/assistant/docs", { documentId });

      expect(response.status).toBe(202);
      expect(s.docQa.ingest.start).toHaveBeenCalledWith(userId, expect.any(String), documentId);
    });

    it("rejects a missing or malformed documentId", async () => {
      const app = createApp(config, services());
      expect((await post(app, "/assistant/docs", {})).status).toBe(400);
      expect((await post(app, "/assistant/docs", { documentId: "nope" })).status).toBe(400);
      expect((await post(app, "/assistant/docs", "not json")).status).toBe(400);
    });

    it("is 404 for another user's document, 409 while it is running, and 502 on anything else", async () => {
      const failing = (error: Error) => createApp(config, services({ ingest: { start: async () => { throw error; } } }));
      expect((await post(failing(new DocNotFoundError()), "/assistant/docs", { documentId })).status).toBe(404);
      const busy = await post(failing(new DocBusyError()), "/assistant/docs", { documentId });
      expect(busy.status).toBe(409);
      expect((await busy.json()).detail).toContain("already being processed");
      expect((await post(failing(new Error("db down")), "/assistant/docs", { documentId })).status).toBe(502);
    });
  });

  describe("POST /assistant/docs/ask", () => {
    it("returns the answer and sources", async () => {
      const s = services();
      const response = await post(createApp(config, s), "/assistant/docs/ask", { documentId, question: "  How long?  " });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ answer: "Sixty days (p. 3).", sources: [{ page: 3, snippet: "s" }] });
      expect(s.docQa.ask.ask).toHaveBeenCalledWith(userId, expect.any(String), documentId, "How long?");
    });

    it("rejects a bad document id, and a missing, blank or too long question", async () => {
      const app = createApp(config, services());
      expect((await post(app, "/assistant/docs/ask", { documentId: "x", question: "Q?" })).status).toBe(400);
      expect((await post(app, "/assistant/docs/ask", { documentId })).status).toBe(400);
      expect((await post(app, "/assistant/docs/ask", { documentId, question: "   " })).status).toBe(400);
      const tooLong = await post(app, "/assistant/docs/ask", { documentId, question: "x".repeat(1001) });
      expect(tooLong.status).toBe(400);
      expect((await tooLong.json()).detail).toContain("at most 1000");
    });

    it("is 404 for another user's document and 409 when it is not ready", async () => {
      const failing = (e: Error) => createApp(config, services({ ask: { ask: async () => { throw e; } } }));
      expect((await post(failing(new DocNotFoundError()), "/assistant/docs/ask", { documentId, question: "Q?" })).status).toBe(404);
      const notReady = await post(failing(new DocNotReadyError("processing")), "/assistant/docs/ask", { documentId, question: "Q?" });
      expect(notReady.status).toBe(409);
      expect((await notReady.json()).detail).toContain("processing");
    });

    it("is 503 when the model quota is used up and 502 on other failures, without logging the question", async () => {
      const quota = Object.assign(new Error("quota"), { status: 429 });
      expect((await post(createApp(config, services({ ask: { ask: async () => { throw quota; } } })), "/assistant/docs/ask", { documentId, question: "Q?" })).status).toBe(503);

      const app = createApp(config, services({ ask: { ask: async () => { throw new Error("model down"); } } }));
      const response = await post(app, "/assistant/docs/ask", { documentId, question: "my private question" });
      expect(response.status).toBe(502);
      expect(JSON.stringify(error.mock.calls)).not.toContain("my private question");
    });

    it("limits each user to 10 questions a minute", async () => {
      const app = createApp(config, services());
      for (let i = 0; i < 10; i++) expect((await post(app, "/assistant/docs/ask", { documentId, question: "Q?" })).status).toBe(200);
      expect((await post(app, "/assistant/docs/ask", { documentId, question: "Q?" })).status).toBe(429);
    });
  });
});
