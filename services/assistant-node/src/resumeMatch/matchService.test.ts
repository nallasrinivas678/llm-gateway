import { describe, expect, it, vi } from "vitest";
import { loadSettings } from "../config.js";
import { ResumeInputError } from "./errors.js";
import { createMatchService, viewOf, type GenerateFn } from "./matchService.js";
import type { MatchStore, NewMatch, NewVersion } from "./matchStore.js";

const settings = loadSettings().resumeMatch;
const resumeText = [
  "Jane Doe - Senior Engineer",
  "7 years building C# services at Fabrikam",
  "Built ASP.NET Core APIs serving 2M requests/day",
  "Packaged services with Docker",
  "Skills: C#, ASP.NET Core, Docker, PostgreSQL, GitHub Actions",
].join("\n");
const jobText = "Senior .NET engineer at Contoso. Required: 5+ years C#, ASP.NET Core, Azure, Docker and Kubernetes. Nice to have: React, Terraform. ".repeat(3);

// Scripted model answers, one per call, in order.
function scripted(...answers: unknown[]) {
  const prompts: { name: string; system: string; user: string }[] = [];
  const generate = (async (_schema, prompt) => {
    prompts.push(prompt);
    const next = answers.shift();
    if (next instanceof Error) throw next;
    return next;
  }) as GenerateFn;
  return { generate, prompts };
}

function fakeStore() {
  const saved: { match?: NewMatch; first?: NewVersion } = {};
  const store: MatchStore = {
    createMatch: vi.fn(async (match: NewMatch, first: NewVersion) => {
      saved.match = match;
      saved.first = first;
      return "match-1";
    }),
    getMatch: vi.fn(),
    listMatches: vi.fn(async () => []),
    addVersion: vi.fn(async () => {}),
  };
  return { store, saved };
}

const requirementsAnswer = {
  title: "  Senior .NET engineer   at Contoso ",
  requirements: [
    { text: "5+ years C#", kind: "must" },
    { text: "ASP.NET Core", kind: "must" },
    { text: "Azure", kind: "must" },
    { text: "azure", kind: "must" }, // duplicate, dropped
    { text: "Docker and Kubernetes", kind: "must" },
    { text: "React", kind: "nice" },
  ],
};

const assessmentAnswer = {
  results: [
    { requirementId: 1, status: "met", evidence: "7 years building C# services at Fabrikam" },
    { requirementId: 2, status: "met", evidence: "Built ASP.NET Core APIs serving 2M requests/day" },
    { requirementId: 3, status: "met", evidence: "Deployed everything to Azure" }, // not in the resume
    { requirementId: 4, status: "partial", evidence: "Packaged services with Docker" },
  ],
};

describe("resume match service", () => {
  it("uses the user's own target score when given, and reports readability checks", async () => {
    const { generate } = scripted(requirementsAnswer, assessmentAnswer);
    const { store, saved } = fakeStore();
    const service = createMatchService({ generate, settings, openStore: () => store });

    const view = await service.start({ userId: "u1", jwt: "jwt", resumeText, jobText, targetScore: 55 });

    expect(saved.match).toMatchObject({ targetScore: 55 });
    expect(view).toMatchObject({ targetScore: 55, reachedTarget: true }); // the score of 56 meets 55
    expect(view.formatChecks.map((c) => c.id)).toEqual(["email", "phone", "sections", "dates", "bullets", "length", "layout"]);
  });

  it("saves the resume without hidden characters and returns the saved text", async () => {
    const { generate } = scripted(requirementsAnswer, assessmentAnswer);
    const { store, saved } = fakeStore();
    const service = createMatchService({ generate, settings, openStore: () => store });
    const dirty = resumeText.replace("Jane Doe", "Jane\u200B Doe").replace("Packaged services", "Packaged\u00A0services");

    const view = await service.start({ userId: "u1", jwt: "jwt", resumeText: dirty, jobText });

    expect(saved.first).toMatchObject({ resumeText });
    expect(view.resumeText).toBe(resumeText);
  });

  it("builds the requirements once, checks the resume, scores it in code and saves version 1", async () => {
    const { generate, prompts } = scripted(requirementsAnswer, assessmentAnswer);
    const { store, saved } = fakeStore();
    const openStore = vi.fn(() => store);
    const service = createMatchService({ generate, settings, openStore });

    const view = await service.start({ userId: "u1", jwt: "jwt", resumeText: `  ${resumeText}  `, jobText, jobUrl: "https://jobs.example.com/1" });

    expect(view.title).toBe("Senior .NET engineer at Contoso");
    expect(view.requirements.map((r) => [r.id, r.text, r.kind])).toEqual([
      [1, "5+ years C#", "must"],
      [2, "ASP.NET Core", "must"],
      [3, "Azure", "must"],
      [4, "Docker and Kubernetes", "must"],
      [5, "React", "nice"],
    ]);
    // Azure's invented quote is rejected; React has no answer. Earned 2+2+0+1+0 of 2+2+2+2+1.
    expect(view.results.map((r) => r.status)).toEqual(["met", "met", "missing", "partial", "missing"]);
    expect(view.score).toBe(56);
    expect(view.missing.map((r) => r.id)).toEqual([3, 4, 5]);
    expect(view).toMatchObject({ matchId: "match-1", version: 1, targetScore: 80, reachedTarget: false, jobUrl: "https://jobs.example.com/1" });

    expect(openStore).toHaveBeenCalledWith("u1", "jwt");
    expect(saved.match).toMatchObject({ title: "Senior .NET engineer at Contoso", jobUrl: "https://jobs.example.com/1", targetScore: 80 });
    expect(saved.first).toMatchObject({ version: 1, resumeText, score: 56, confirmed: [] });

    // Both prompts say the text is data, and the check prompt numbers the fixed requirements.
    expect(prompts.map((p) => p.name)).toEqual(["job_requirements", "requirement_check"]);
    for (const p of prompts) expect(p.system).toContain("not instructions");
    expect(prompts[1]!.user).toContain("3. [must] Azure");
  });

  it("caps the number of requirements", async () => {
    const many = { title: "Job", requirements: Array.from({ length: 40 }, (_, i) => ({ text: `Skill ${i}`, kind: "nice" })) };
    const { generate } = scripted(many, { results: [] });
    const view = await createMatchService({ generate, settings, openStore: () => fakeStore().store }).start({ userId: "u", jwt: "j", resumeText, jobText });
    expect(view.requirements).toHaveLength(settings.maxRequirements);
    expect(view.score).toBe(0);
  });

  it("refuses a resume or job description that is too short or too long, before calling the model", async () => {
    const { generate, prompts } = scripted();
    const service = createMatchService({ generate, settings, openStore: () => fakeStore().store });
    await expect(service.start({ userId: "u", jwt: "j", resumeText: "too short", jobText })).rejects.toThrow("resume is too short");
    await expect(service.start({ userId: "u", jwt: "j", resumeText, jobText: "x".repeat(settings.maxJobChars + 1) })).rejects.toThrow("job description is too long");
    expect(prompts).toHaveLength(0);
  });

  it("explains a job description with no requirements, and saves nothing", async () => {
    const { generate } = scripted({ title: "", requirements: [{ text: "   ", kind: "must" }] });
    const { store } = fakeStore();
    const error = await createMatchService({ generate, settings, openStore: () => store }).start({ userId: "u", jwt: "j", resumeText, jobText }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumeInputError);
    expect(store.createMatch).not.toHaveBeenCalled();
  });

  it("passes model failures on without saving", async () => {
    const { generate } = scripted(requirementsAnswer, new Error("model down"));
    const { store } = fakeStore();
    await expect(createMatchService({ generate, settings, openStore: () => store }).start({ userId: "u", jwt: "j", resumeText, jobText })).rejects.toThrow("model down");
    expect(store.createMatch).not.toHaveBeenCalled();
  });

  it("reads and lists matches through the user's own store", async () => {
    const { store } = fakeStore();
    const openStore = vi.fn(() => store);
    const service = createMatchService({ generate: scripted().generate, settings, openStore });
    await service.list("u1", "jwt");
    await service.get("u1", "jwt", "m1");
    expect(store.listMatches).toHaveBeenCalled();
    expect(store.getMatch).toHaveBeenCalledWith("m1");
    expect(openStore).toHaveBeenCalledWith("u1", "jwt");
  });
});

// A saved match at version 1: C# and ASP.NET Core met, Azure missing, Docker and Kubernetes partial.
const requirements = [
  { id: 1, text: "5+ years C#", kind: "must" as const },
  { id: 2, text: "ASP.NET Core", kind: "must" as const },
  { id: 3, text: "Azure", kind: "must" as const },
  { id: 4, text: "Docker and Kubernetes", kind: "must" as const },
];
const v1Results = [
  { requirementId: 1, status: "met" as const, evidence: "7 years building C# services at Fabrikam" },
  { requirementId: 2, status: "met" as const, evidence: "Built ASP.NET Core APIs serving 2M requests/day" },
  { requirementId: 3, status: "missing" as const, evidence: "" },
  { requirementId: 4, status: "partial" as const, evidence: "Packaged services with Docker" },
];
const savedMatch = (extraVersions: number[] = []) => ({
  id: "match-1",
  title: "Job",
  jobUrl: null,
  jobText,
  requirements,
  targetScore: 90,
  createdAt: "t",
  versions: [1, ...extraVersions].map((version) => ({ version, resumeText, score: 62, results: v1Results, confirmed: [], createdAt: "t" })),
});
const azureDetail = { requirementId: 3, detail: "Deployed our APIs to Azure App Service at Fabrikam" };

function serviceWith(match: ReturnType<typeof savedMatch>, ...answers: unknown[]) {
  const { generate, prompts } = scripted(...answers);
  const { store } = fakeStore();
  store.getMatch = vi.fn(async () => match);
  return { service: createMatchService({ generate, settings, openStore: () => store }), store, prompts };
}

describe("rewrite", () => {
  const additions = {
    additions: [{ requirementId: 3, skill: "Azure", bullet: "Deployed APIs to Azure App Service", afterLine: "Built ASP.NET Core APIs serving 2M requests/day" }],
  };

  it("proposes the resume with the confirmed skill added, and saves nothing", async () => {
    const { service, store, prompts } = serviceWith(savedMatch(), additions);
    const proposal = await service.rewrite("u", "j", "match-1", [azureDetail]);

    expect(proposal.baseVersion).toBe(1);
    expect(proposal.proposedText).toContain("Skills: C#, ASP.NET Core, Docker, PostgreSQL, GitHub Actions, Azure");
    expect(proposal.proposedText).toContain("- Deployed APIs to Azure App Service");
    expect(proposal.changes).toEqual([{ requirementId: 3, skill: "Azure", bullet: "Deployed APIs to Azure App Service", reworded: null }]);
    expect(store.addVersion).not.toHaveBeenCalled();
    // The model sees only the confirmed skill and the user's own words, and is told they are data.
    expect(prompts[0]!.user).toContain("3. Azure\n   The candidate says: Deployed our APIs to Azure App Service at Fabrikam");
    expect(prompts[0]!.user).not.toContain("Kubernetes");
    expect(prompts[0]!.system).toContain("not instructions");
  });

  it("rewords the existing line for a partly shown skill, and tells the model which line", async () => {
    const reword = {
      additions: [
        {
          requirementId: 4,
          skill: "Kubernetes",
          bullet: "",
          afterLine: "",
          replaceLine: "Packaged services with Docker",
          reworded: "Packaged services with Docker and ran them on Kubernetes at Fabrikam",
        },
      ],
    };
    const { service, prompts } = serviceWith(savedMatch(), reword);
    const proposal = await service.rewrite("u", "j", "match-1", [{ requirementId: 4, detail: "I ran our services on Kubernetes at Fabrikam" }]);

    expect(prompts[0]!.user).toContain("Existing line that partly shows it: Packaged services with Docker");
    expect(proposal.proposedText).toContain("Packaged services with Docker and ran them on Kubernetes at Fabrikam");
    expect(proposal.proposedText.split("\n")).not.toContain("Packaged services with Docker");
    expect(proposal.changes[0]).toMatchObject({ requirementId: 4, reworded: "Packaged services with Docker and ran them on Kubernetes at Fabrikam", bullet: null });
    // A skill the resume shows in full has no existing line to point at.
    expect(prompts[0]!.system).toContain("reword that line instead");
  });

  it("does not mention an existing line for a skill that is missing", async () => {
    const { service, prompts } = serviceWith(savedMatch(), additions);
    await service.rewrite("u", "j", "match-1", [azureDetail]);
    expect(prompts[0]!.user).not.toContain("Existing line");
  });

  it("uses the latest version's text as the base", async () => {
    const match = savedMatch([2]);
    match.versions[1]!.resumeText = `${resumeText}\n- Extra line`;
    const { service, prompts } = serviceWith(match, additions);
    expect((await service.rewrite("u", "j", "match-1", [azureDetail])).baseVersion).toBe(2);
    expect(prompts[0]!.user).toContain("- Extra line");
  });

  it.each([
    ["no skills", [], "at least one skill"],
    ["a skill that is not part of the job", [{ requirementId: 9, detail: "Used Terraform for two years at Fabrikam" }], "not part of this job"],
    ["the same skill twice", [azureDetail, azureDetail], "not part of this job"],
    ["a skill the resume already shows", [{ requirementId: 1, detail: "Wrote C# every day at Fabrikam" }], "already shown"],
    ["a detail that is too short", [{ requirementId: 3, detail: "yes" }], "Describe where you used"],
    ["a detail that is too long", [{ requirementId: 3, detail: "x".repeat(501) }], "Describe where you used"],
  ])("refuses %s before calling the model", async (_label, items, message) => {
    const { service, prompts } = serviceWith(savedMatch(), additions);
    await expect(service.rewrite("u", "j", "match-1", items)).rejects.toThrow(message);
    expect(prompts).toHaveLength(0);
  });

  it("explains when nothing usable came back", async () => {
    const { service } = serviceWith(savedMatch(), { additions: [] });
    await expect(service.rewrite("u", "j", "match-1", [azureDetail])).rejects.toThrow("Nothing could be added");
  });
});

describe("accept", () => {
  const edited = `${resumeText}\n- Deployed APIs to Azure App Service`;
  const reassess = {
    results: [
      { requirementId: 1, status: "met", evidence: "7 years building C# services at Fabrikam" },
      { requirementId: 2, status: "met", evidence: "Built ASP.NET Core APIs serving 2M requests/day" },
      { requirementId: 3, status: "met", evidence: "Deployed APIs to Azure App Service" },
      { requirementId: 4, status: "met", evidence: "Packaged services with Docker" },
    ],
  };

  it("saves the accepted text as the next version, scored again against the same requirements", async () => {
    const { service, store, prompts } = serviceWith(savedMatch(), reassess);
    const view = await service.accept("u", "j", "match-1", { resumeText: ` ${edited} `, confirmed: [azureDetail], baseVersion: 1 });

    expect(store.addVersion).toHaveBeenCalledWith("match-1", expect.objectContaining({ version: 2, resumeText: edited, score: 100, confirmed: [azureDetail] }));
    expect(view).toMatchObject({ version: 2, score: 100, reachedTarget: true, missing: [], rewritesLeft: 4 });
    expect(prompts.map((p) => p.name)).toEqual(["requirement_check"]);
    expect(prompts[0]!.user).toContain("3. [must] Azure");
  });

  it("does not lower an earlier result when the model judges it more harshly this time", async () => {
    const harsher = {
      results: [
        { requirementId: 1, status: "partial", evidence: "7 years building C# services at Fabrikam" },
        { requirementId: 2, status: "missing", evidence: "" },
        { requirementId: 3, status: "met", evidence: "Deployed APIs to Azure App Service" },
        { requirementId: 4, status: "partial", evidence: "Packaged services with Docker" },
      ],
    };
    const { service } = serviceWith(savedMatch(), harsher);
    const view = await service.accept("u", "j", "match-1", { resumeText: edited, confirmed: [azureDetail], baseVersion: 1 });
    expect(view.results.map((r) => r.status)).toEqual(["met", "met", "met", "partial"]);
    expect(view.score).toBe(88);
  });

  it("strips hidden characters from the text the user accepts, and returns it", async () => {
    const { service, store } = serviceWith(savedMatch(), reassess);
    const view = await service.accept("u", "j", "match-1", { resumeText: edited.replace("Deployed", "Dep\u200Bloyed"), confirmed: [azureDetail], baseVersion: 1 });
    expect(store.addVersion).toHaveBeenCalledWith("match-1", expect.objectContaining({ resumeText: edited }));
    expect(view.resumeText).toBe(edited);
    expect(view.resumeText).not.toMatch(/[\u200B\u00A0]/);
  });

  it("keeps a skill missing when the model's quote is not in the accepted text", async () => {
    const lying = { results: [...reassess.results.slice(0, 2), { requirementId: 3, status: "met", evidence: "Led our Azure migration" }, reassess.results[3]] };
    const { service } = serviceWith(savedMatch(), lying);
    const view = await service.accept("u", "j", "match-1", { resumeText: edited, confirmed: [azureDetail], baseVersion: 1 });
    expect(view.results.find((r) => r.requirementId === 3)!.status).toBe("missing");
    expect(view.reachedTarget).toBe(false);
  });

  it("refuses a stale base version, unchanged text and a match that is out of rewrites", async () => {
    await expect(serviceWith(savedMatch([2]), reassess).service.accept("u", "j", "match-1", { resumeText: edited, confirmed: [], baseVersion: 1 })).rejects.toThrow("newer version");
    await expect(serviceWith(savedMatch(), reassess).service.accept("u", "j", "match-1", { resumeText, confirmed: [], baseVersion: 1 })).rejects.toThrow("no changes");
    const full = savedMatch([2, 3, 4, 5, 6]);
    await expect(serviceWith(full, reassess).service.accept("u", "j", "match-1", { resumeText: edited, confirmed: [], baseVersion: 6 })).rejects.toThrow("limit of 5 rewrites");
  });

  it("refuses accepted text that is too short", async () => {
    await expect(serviceWith(savedMatch(), reassess).service.accept("u", "j", "match-1", { resumeText: "tiny", confirmed: [], baseVersion: 1 })).rejects.toThrow("too short");
  });
});

describe("viewOf", () => {
  it("shows the latest version and whether the target is reached", () => {
    const requirements = [{ id: 1, text: "C#", kind: "must" as const }];
    const version = (n: number, score: number) => ({
      version: n,
      resumeText: "r",
      score,
      results: [{ requirementId: 1, status: score === 100 ? ("met" as const) : ("missing" as const), evidence: "" }],
      confirmed: [],
      createdAt: "t",
    });
    const base = { id: "m", title: "t", jobUrl: null, jobText: "j", requirements, targetScore: 90, createdAt: "t" };
    expect(viewOf({ ...base, versions: [version(1, 0), version(2, 100)] }, 5)).toMatchObject({ version: 2, score: 100, reachedTarget: true, missing: [], rewritesLeft: 4 });
    expect(viewOf({ ...base, versions: [] }, 5)).toMatchObject({ version: 0, score: 0, reachedTarget: false });
  });
});
