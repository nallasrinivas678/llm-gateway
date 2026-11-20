import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { MatchNotFoundError, ResumeInputError, VersionConflictError } from "./resumeMatch/errors.js";
import type { MatchService, MatchView } from "./resumeMatch/matchService.js";
import { makePdf } from "./resumeMatch/pdf.testutil.js";

const secret = "test-secret-test-secret-test-secret-123";
const issuer = "https://example.supabase.co/auth/v1";
const config = loadConfig({ SUPABASE_JWT_ISSUER: issuer, SUPABASE_JWT_SECRET: secret });
const userId = "11111111-1111-1111-1111-111111111111";
const matchId = "3f1c2a4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b";

const token = () =>
  new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer(issuer).setExpirationTime("5m").sign(new TextEncoder().encode(secret));

const view: MatchView = {
  matchId,
  title: "Job",
  jobUrl: null,
  targetScore: 90,
  rewritesLeft: 5,
  requirements: [{ id: 1, text: "C#", kind: "must" }],
  version: 1,
  score: 100,
  results: [{ requirementId: 1, status: "met", evidence: "C#" }],
  missing: [],
  reachedTarget: true,
  resumeText: "r",
  formatChecks: [{ id: "email", ok: true, message: "Email address found." }],
};

function fakeService(overrides: Partial<MatchService> = {}) {
  return {
    start: vi.fn(async () => view),
    list: vi.fn(async () => [{ id: matchId, title: "Job", jobUrl: null, createdAt: "t", latestVersion: 1, latestScore: 100 }]),
    get: vi.fn(async () => ({ id: matchId, title: "Job", jobUrl: null, jobText: "j", requirements: view.requirements, targetScore: 90, createdAt: "t", versions: [{ version: 1, resumeText: "r", score: 100, results: view.results, confirmed: [], createdAt: "t" }] })),
    rewrite: vi.fn(async () => proposal),
    accept: vi.fn(async () => view),
    ...overrides,
  } as unknown as MatchService;
}

const proposal = { baseVersion: 1, proposedText: "new text", changes: [{ requirementId: 3, skill: "Azure", bullet: "Deployed APIs" }], skipped: [] };

async function call(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}, withToken = true) {
  const headers = new Headers(init.headers);
  if (withToken) headers.set("authorization", `Bearer ${await token()}`);
  return app.request(path, { ...init, headers });
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("resume routes", () => {
  it("require a login token", async () => {
    const app = createApp(config, { resumeMatch: fakeService() });
    expect((await call(app, "/resume/matches", {}, false)).status).toBe(401);
    expect((await call(app, "/resume/extract", { method: "POST" }, false)).status).toBe(401);
  });

  it("answer 503 for matches when the service is not configured", async () => {
    const app = createApp(config, {});
    expect((await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j" }))).status).toBe(503);
    expect((await call(app, "/resume/matches")).status).toBe(503);
    expect((await call(app, `/resume/matches/${matchId}`)).status).toBe(503);
  });
});

describe("POST /resume/extract", () => {
  const upload = (file: Blob, name = "resume.pdf") => {
    const form = new FormData();
    form.set("file", file, name);
    return { method: "POST", body: form };
  };

  it("returns the PDF text", async () => {
    const pdf = makePdf([["Jane Doe - Senior Engineer", "7 years building C# services at Fabrikam", "Built ASP.NET Core APIs serving 2M requests/day", "Skills: C#, ASP.NET Core, Docker, PostgreSQL, GitHub Actions", "Led a team of five engineers moving services to containers"]]);
    const res = await call(createApp(config), "/resume/extract", upload(new Blob([new Uint8Array(pdf)], { type: "application/pdf" })));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toContain("7 years building C# services at Fabrikam");
  });

  it("explains an unusable file with 400 and a detail", async () => {
    const res = await call(createApp(config), "/resume/extract", upload(new Blob(["not a pdf"], { type: "text/plain" })));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "The file is not a PDF." });
  });

  it("asks for a file when none is sent", async () => {
    const res = await call(createApp(config), "/resume/extract", { method: "POST", body: new FormData() });
    expect(res.status).toBe(400);
  });

  it("refuses an upload over the size limit with 413", async () => {
    const big = new Uint8Array(config.settings.resumeMatch.maxPdfBytes + 100 * 1024);
    const res = await call(createApp(config), "/resume/extract", upload(new Blob([big])));
    expect(res.status).toBe(413);
  });
});

describe("POST /resume/job-text", () => {
  it("refuses private addresses with 422 and a detail", async () => {
    const res = await call(createApp(config), "/resume/job-text", json({ url: "http://127.0.0.1/admin" }));
    expect(res.status).toBe(422);
    expect(((await res.json()) as { detail: string }).detail).toContain("can't be read");
  });

  it("rejects a missing url", async () => {
    expect((await call(createApp(config), "/resume/job-text", json({}))).status).toBe(400);
  });
});

describe("POST /resume/matches", () => {
  it("starts a match for the logged-in user", async () => {
    const service = fakeService();
    const res = await call(createApp(config, { resumeMatch: service }), "/resume/matches", json({ resumeText: "resume", jobText: "job", jobUrl: "https://jobs.example.com/1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(service.start).toHaveBeenCalledWith({ userId, jwt: expect.any(String), resumeText: "resume", jobText: "job", jobUrl: "https://jobs.example.com/1" });
  });

  it("passes the user's own target score on, within 50 to 100", async () => {
    const service = fakeService();
    const app = createApp(config, { resumeMatch: service });
    expect((await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j", targetScore: 70 }))).status).toBe(200);
    expect(service.start).toHaveBeenCalledWith(expect.objectContaining({ targetScore: 70 }));
    expect((await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j", targetScore: 40 }))).status).toBe(400);
    expect((await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j", targetScore: 101 }))).status).toBe(400);
    expect((await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j", targetScore: 80.5 }))).status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const app = createApp(config, { resumeMatch: fakeService() });
    expect((await call(app, "/resume/matches", json({ resumeText: 5 }))).status).toBe(400);
    expect((await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j", jobUrl: "not a url" }))).status).toBe(400);
  });

  it("returns readable input errors as 400", async () => {
    const service = fakeService({ start: vi.fn(async () => Promise.reject(new ResumeInputError("The resume is too short."))) });
    const res = await call(createApp(config, { resumeMatch: service }), "/resume/matches", json({ resumeText: "r", jobText: "j" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "The resume is too short." });
  });

  it("hides other failures behind a generic 502", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = fakeService({ start: vi.fn(async () => Promise.reject(new Error("secret internals"))) });
    const res = await call(createApp(config, { resumeMatch: service }), "/resume/matches", json({ resumeText: "r", jobText: "j" }));
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret internals");
    error.mockRestore();
  });

  it("says when the model's usage limit is reached", async () => {
    const service = fakeService({ start: vi.fn(async () => Promise.reject(Object.assign(new Error("quota"), { status: 429 }))) });
    const res = await call(createApp(config, { resumeMatch: service }), "/resume/matches", json({ resumeText: "r", jobText: "j" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { detail: string }).detail).toContain("usage limit");
  });

  it("limits model requests per user per minute", async () => {
    const app = createApp(config, { resumeMatch: fakeService() });
    const limit = config.settings.resumeMatch.requestsPerMinute;
    for (let i = 0; i < limit; i++) expect((await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j" }))).status).toBe(200);
    const res = await call(app, "/resume/matches", json({ resumeText: "r", jobText: "j" }));
    expect(res.status).toBe(429);
  });
});

describe("POST /resume/place-bullet", () => {
  const place = (app: ReturnType<typeof createApp>, body: unknown, withToken = true) => call(app, "/resume/place-bullet", json(body), withToken);
  const text = "Fabrikam - Engineer\n- Built APIs\nContoso - Engineer\n- Wrote C#";

  it("puts the bullet under the chosen role", async () => {
    const res = await place(createApp(config, { resumeMatch: fakeService() }), { resumeText: text, under: "Fabrikam - Engineer", bullet: "Deployed to Azure" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resumeText: "Fabrikam - Engineer\n- Built APIs\n- Deployed to Azure\nContoso - Engineer\n- Wrote C#" });
  });

  it("needs a login, a valid body and a role that is in the resume", async () => {
    const app = createApp(config, { resumeMatch: fakeService() });
    expect((await place(app, { resumeText: text, under: "Fabrikam - Engineer", bullet: "x" }, false)).status).toBe(401);
    expect((await place(app, { resumeText: text })).status).toBe(400);
    const missing = await place(app, { resumeText: text, under: "Globex - Engineer", bullet: "Deployed to Azure" });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { detail: string }).detail).toContain("Choose a line");
  });
});

describe("POST /resume/matches/:id/rewrite and /versions", () => {
  const confirmed = [{ requirementId: 3, detail: "Deployed our APIs to Azure App Service" }];
  const rewrite = (app: ReturnType<typeof createApp>, body: unknown, id = matchId) => call(app, `/resume/matches/${id}/rewrite`, json(body));
  const save = (app: ReturnType<typeof createApp>, body: unknown, id = matchId) => call(app, `/resume/matches/${id}/versions`, json(body));
  const accepted = { resumeText: "new text", confirmed, baseVersion: 1 };

  it("proposes a rewrite for the logged-in user's match", async () => {
    const service = fakeService();
    const res = await rewrite(createApp(config, { resumeMatch: service }), { confirmed });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(proposal);
    expect(service.rewrite).toHaveBeenCalledWith(userId, expect.any(String), matchId, confirmed);
  });

  it("saves an accepted version and returns the new score", async () => {
    const service = fakeService();
    const res = await save(createApp(config, { resumeMatch: service }), accepted);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(view);
    expect(service.accept).toHaveBeenCalledWith(userId, expect.any(String), matchId, accepted);
  });

  it("need a login token, a configured service and a valid id and body", async () => {
    const app = createApp(config, { resumeMatch: fakeService() });
    expect((await call(app, `/resume/matches/${matchId}/rewrite`, json({ confirmed }), false)).status).toBe(401);
    expect((await rewrite(createApp(config, {}), { confirmed })).status).toBe(503);
    expect((await rewrite(app, { confirmed }, "not-a-uuid")).status).toBe(404);
    expect((await rewrite(app, { confirmed: "no" })).status).toBe(400);
    expect((await save(app, { ...accepted, baseVersion: 0 })).status).toBe(400);
    expect((await save(app, { resumeText: "x" })).status).toBe(400);
  });

  it.each([
    ["unknown match", new MatchNotFoundError(), 404, "not found"],
    ["unusable input", new ResumeInputError("Choose at least one skill you have."), 400, "Choose at least one"],
    ["a newer version saved first", new VersionConflictError(), 409, "newer version"],
    ["the model's usage limit", Object.assign(new Error("quota"), { status: 429 }), 503, "usage limit"],
  ])("answers %s with a readable detail", async (_label, failure, status, detail) => {
    const service = fakeService({ rewrite: vi.fn(async () => Promise.reject(failure)), accept: vi.fn(async () => Promise.reject(failure)) });
    const app = createApp(config, { resumeMatch: service });
    for (const res of [await rewrite(app, { confirmed }), await save(app, accepted)]) {
      expect(res.status).toBe(status);
      expect(((await res.json()) as { detail: string }).detail).toContain(detail);
    }
  });

  it("hides other failures behind a generic 502", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = fakeService({ rewrite: vi.fn(async () => Promise.reject(new Error("secret internals"))) });
    const res = await rewrite(createApp(config, { resumeMatch: service }), { confirmed });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("secret internals");
    error.mockRestore();
  });

  it("share the per-user rate limit with starting a match", async () => {
    const app = createApp(config, { resumeMatch: fakeService() });
    const limit = config.settings.resumeMatch.requestsPerMinute;
    for (let i = 0; i < limit; i++) expect((await rewrite(app, { confirmed })).status).toBe(200);
    expect((await save(app, accepted)).status).toBe(429);
  });
});

describe("GET /resume/matches", () => {
  it("lists the user's matches", async () => {
    const res = await call(createApp(config, { resumeMatch: fakeService() }), "/resume/matches");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matches: unknown[] }).matches).toHaveLength(1);
  });

  it("returns one match with its latest view and every version", async () => {
    const res = await call(createApp(config, { resumeMatch: fakeService() }), `/resume/matches/${matchId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MatchView & { versions: unknown[] };
    expect(body).toMatchObject({ matchId, score: 100, reachedTarget: true });
    expect(body.versions).toHaveLength(1);
  });

  it("answers 404 for an unknown, foreign or malformed id", async () => {
    const service = fakeService({ get: vi.fn(async () => Promise.reject(new MatchNotFoundError())) });
    const app = createApp(config, { resumeMatch: service });
    expect((await call(app, `/resume/matches/${matchId}`)).status).toBe(404);
    expect((await call(app, "/resume/matches/not-a-uuid")).status).toBe(404);
  });

  it("hides read failures behind a 502", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = fakeService({
      list: vi.fn(async () => Promise.reject(new Error("db down"))),
      get: vi.fn(async () => Promise.reject(new Error("db down"))),
    });
    const app = createApp(config, { resumeMatch: service });
    expect((await call(app, "/resume/matches")).status).toBe(502);
    expect((await call(app, `/resume/matches/${matchId}`)).status).toBe(502);
    error.mockRestore();
  });
});
