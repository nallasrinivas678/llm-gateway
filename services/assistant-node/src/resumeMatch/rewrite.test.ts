import { describe, expect, it } from "vitest";
import { applyAdditions, placeBullet, roleLines, type Addition, type ConfirmedItem } from "./rewrite.js";

const resume = [
  "Jane Doe",
  "",
  "SKILLS",
  "C#, ASP.NET Core, Docker",
  "",
  "EXPERIENCE",
  "Fabrikam - Senior Engineer, 2019-2026",
  "- Built ASP.NET Core APIs serving 2M requests/day",
  "- Packaged services with Docker",
  "Contoso - Engineer, 2015-2019",
  "- Wrote C# services",
].join("\n");

const azure: ConfirmedItem = {
  requirementId: 3,
  requirementText: "Microsoft Azure",
  detail: "Deployed our APIs to Azure App Service at Fabrikam, about 3 years",
};
const k8s: ConfirmedItem = { requirementId: 4, requirementText: "Kubernetes", detail: "Ran 12 services on Kubernetes at Contoso" };

const azureAddition: Addition = {
  requirementId: 3,
  skill: "Azure",
  bullet: "Deployed APIs to Azure App Service",
  afterLine: "Fabrikam - Senior Engineer, 2019-2026",
};

describe("applyAdditions", () => {
  it("adds the skill to the skills line and the bullet after the job's last bullet, leaving every other line alone", () => {
    const { text, changes, skipped } = applyAdditions(resume, [azureAddition], [azure]);
    const lines = text.split("\n");

    expect(lines[3]).toBe("C#, ASP.NET Core, Docker, Azure");
    // After "- Packaged services with Docker", before the next job.
    expect(lines.indexOf("- Deployed APIs to Azure App Service")).toBe(lines.indexOf("- Packaged services with Docker") + 1);
    expect(lines.indexOf("Contoso - Engineer, 2015-2019")).toBe(lines.indexOf("- Deployed APIs to Azure App Service") + 1);
    // Everything that was there is still there, in order.
    const kept = text.split("\n").filter((l) => resume.split("\n").includes(l) || l === "C#, ASP.NET Core, Docker, Azure");
    expect(kept.length).toBe(resume.split("\n").length);
    expect(changes).toEqual([{ requirementId: 3, skill: "Azure", bullet: "Deployed APIs to Azure App Service", reworded: null }]);
    expect(skipped).toEqual([]);
  });

  it("ignores suggestions for skills the user did not confirm, and reports confirmed ones with no suggestion", () => {
    const stray: Addition = { requirementId: 99, skill: "Terraform", bullet: "Used Terraform", afterLine: "" };
    const { text, skipped } = applyAdditions(resume, [stray], [azure]);
    expect(text).toBe(resume);
    expect(skipped).toEqual([{ requirementId: 3, reason: "no suggestion came back for it" }]);
  });

  it("only takes a skill name that comes from the requirement or the user's words", () => {
    const sneaky: Addition = { ...azureAddition, skill: "Terraform", bullet: "" };
    const { text, changes } = applyAdditions(resume, [sneaky], [azure]);
    expect(text).toBe(resume);
    expect(changes[0]).toMatchObject({ skill: null, bullet: null });
  });

  it("does not add a skill the resume already lists", () => {
    const { text } = applyAdditions(resume, [{ requirementId: 4, skill: "Docker", bullet: "", afterLine: "" }], [{ requirementId: 4, requirementText: "Docker and Kubernetes", detail: "Ran Docker in production at Fabrikam" }]);
    expect(text).toBe(resume);
  });

  it("drops a bullet with numbers the user did not give, but keeps the skill", () => {
    const { text, changes, skipped } = applyAdditions(resume, [{ ...azureAddition, bullet: "Deployed APIs to Azure App Service, cutting costs 40%" }], [azure]);
    expect(text).not.toContain("40%");
    expect(text).toContain("C#, ASP.NET Core, Docker, Azure");
    expect(changes[0]).toMatchObject({ skill: "Azure", bullet: null });
    expect(skipped[0]).toMatchObject({ requirementId: 3, reason: expect.stringContaining("numbers") });
  });

  it("allows numbers the user gave, in other formats", () => {
    const { text } = applyAdditions(resume, [{ requirementId: 4, skill: "Kubernetes", bullet: "Ran 12 services on Kubernetes at Contoso", afterLine: "Contoso - Engineer, 2015-2019" }], [k8s]);
    expect(text).toContain("- Ran 12 services on Kubernetes at Contoso");
  });

  it("drops a bullet that names an employer or tool nobody mentioned", () => {
    const { text, skipped } = applyAdditions(resume, [{ ...azureAddition, bullet: "Deployed APIs to Azure App Service at Globex" }], [azure]);
    expect(text).not.toContain("Globex");
    expect(skipped[0]).toMatchObject({ reason: expect.stringContaining("named something") });
  });

  it("drops a bullet that is too long", () => {
    const { skipped } = applyAdditions(resume, [{ ...azureAddition, bullet: `Deployed ${"x".repeat(310)}` }], [azure]);
    expect(skipped[0]!.reason).toContain("too long");
  });

  it("leaves a bullet out, and reports it, when the suggested line does not exist", () => {
    const { text, changes, unplaced } = applyAdditions(resume, [{ ...azureAddition, afterLine: "Some job that is not in the resume" }], [azure]);
    expect(text).not.toContain("Deployed APIs");
    expect(text).not.toContain("ADDITIONAL EXPERIENCE");
    expect(changes[0]).toMatchObject({ skill: "Azure", bullet: null });
    expect(unplaced).toEqual([{ requirementId: 3, bullet: "Deployed APIs to Azure App Service" }]);
  });

  it("matches the suggested line ignoring case, spacing and dashes", () => {
    const { text, unplaced } = applyAdditions(resume, [{ ...azureAddition, afterLine: "fabrikam \u2013 senior  engineer, 2019-2026" }], [azure]);
    expect(text).toContain("- Deployed APIs to Azure App Service");
    expect(unplaced).toEqual([]);
  });

  it("adds several skills in one list, without repeating one", () => {
    const { text } = applyAdditions(resume, [azureAddition, { requirementId: 4, skill: "Kubernetes", bullet: "", afterLine: "" }, { requirementId: 4, skill: "Kubernetes", bullet: "", afterLine: "" }], [azure, k8s]);
    expect(text.split("\n")[3]).toBe("C#, ASP.NET Core, Docker, Azure, Kubernetes");
  });

  it("finds a one-line 'Skills:' entry, and creates a section when there is none", () => {
    const inline = applyAdditions("Jane\nSkills: C#, Docker.\nWorked at Fabrikam", [{ ...azureAddition, bullet: "" }], [azure]).text;
    expect(inline).toBe("Jane\nSkills: C#, Docker, Azure\nWorked at Fabrikam");

    const none = applyAdditions("Jane\nWorked at Fabrikam\n\n", [{ ...azureAddition, bullet: "" }], [azure]).text;
    expect(none).toBe("Jane\nWorked at Fabrikam\n\nSKILLS\nAzure");

    // A heading followed by another heading is not a list to extend.
    const emptyHeading = applyAdditions("SKILLS\n\nEXPERIENCE\n- Did things", [{ ...azureAddition, bullet: "" }], [azure]).text;
    expect(emptyHeading.endsWith("\n\nSKILLS\nAzure")).toBe(true);
  });

  it("strips a leading dash from the bullet and extra spaces", () => {
    const { text } = applyAdditions(resume, [{ ...azureAddition, bullet: "  -   Deployed APIs to   Azure App Service " }], [azure]);
    expect(text).toContain("\n- Deployed APIs to Azure App Service\n");
  });
});

describe("roleLines and placeBullet", () => {
  it("lists the lines that have bullets under them, in resume order, without headings or the skills line", () => {
    expect(roleLines(resume)).toEqual(["Fabrikam - Senior Engineer, 2019-2026", "Contoso - Engineer, 2015-2019"]);
    expect(roleLines("Skills: C#\n- not a role")).toEqual([]);
    // A plain-paragraph resume: the dated line is the role.
    expect(roleLines("Jane\nEngineer at Fabrikam, 2019 - Present\nBuilt APIs.")).toEqual(["Engineer at Fabrikam, 2019 - Present"]);
  });

  it("puts the bullet at the end of the chosen role's bullets", () => {
    const text = placeBullet(resume, "Contoso - Engineer, 2015-2019", "  - Ran 12 services on Kubernetes ");
    expect(text.endsWith("- Wrote C# services\n- Ran 12 services on Kubernetes")).toBe(true);
    const first = placeBullet(resume, "Fabrikam - Senior Engineer, 2019-2026", "Led the Azure move");
    const lines = first.split("\n");
    expect(lines[lines.indexOf("- Packaged services with Docker") + 1]).toBe("- Led the Azure move");
  });

  it("refuses a role that is not a line of the resume, and an empty or too long bullet", () => {
    expect(() => placeBullet(resume, "Globex - Engineer", "Did things")).toThrow(RangeError);
    expect(() => placeBullet(resume, "", "Did things")).toThrow(RangeError);
    expect(() => placeBullet(resume, "Contoso - Engineer, 2015-2019", "  ")).toThrow(RangeError);
    expect(() => placeBullet(resume, "Contoso - Engineer, 2015-2019", "x".repeat(301))).toThrow(RangeError);
  });
});

describe("rewording an existing line", () => {
  const years: ConfirmedItem = {
    requirementId: 5,
    requirementText: "5+ years of C#",
    detail: "I have used C# for 8 years at Fabrikam and Contoso",
    evidence: "Wrote C# services",
  };
  const reword = (over: Partial<Addition> = {}): Addition => ({
    requirementId: 5,
    skill: "C#",
    bullet: "",
    afterLine: "",
    replaceLine: "- Wrote C# services",
    reworded: "Wrote C# services at Fabrikam and Contoso for 8 years",
    ...over,
  });
  const run = (addition: Addition, item = years) => applyAdditions(resume, [addition], [item]);

  it("replaces only that line, keeps its bullet and adds no new bullet", () => {
    const { text, changes, skipped } = run(reword());
    const lines = text.split("\n");
    expect(lines).toContain("- Wrote C# services at Fabrikam and Contoso for 8 years");
    expect(lines).not.toContain("- Wrote C# services");
    expect(lines.length).toBe(resume.split("\n").length);
    // Every other line is untouched.
    expect(lines.filter((l) => !l.includes("Wrote C#"))).toEqual(resume.split("\n").filter((l) => !l.includes("Wrote C#")));
    expect(changes[0]).toMatchObject({ requirementId: 5, bullet: null, reworded: "Wrote C# services at Fabrikam and Contoso for 8 years" });
    expect(skipped).toEqual([]);
  });

  it("does not add a second bullet for a skill it reworded", () => {
    const { text } = run(reword({ bullet: "Used C# for 8 years" }));
    expect(text).not.toContain("- Used C# for 8 years");
  });

  it("refuses to change a line the evidence did not come from, and falls back to a bullet if there is one", () => {
    const { text, skipped } = run(reword({ replaceLine: "Fabrikam - Senior Engineer, 2019-2026", reworded: "Fabrikam - Principal Engineer, 2019-2026", afterLine: "Fabrikam - Senior Engineer, 2019-2026", bullet: "Used C# for 8 years at Fabrikam" }));
    expect(text).toContain("Fabrikam - Senior Engineer, 2019-2026");
    expect(text).not.toContain("Principal");
    expect(skipped).toEqual([{ requirementId: 5, reason: "the line to reword was not found in your resume" }]);
    expect(text).toContain("- Used C# for 8 years at Fabrikam");
  });

  it("only rewords when the requirement has an existing partial line", () => {
    const { text, skipped } = run(reword(), { ...years, evidence: undefined });
    expect(text.split("\n")).toContain("- Wrote C# services");
    expect(skipped).toEqual([]);
  });

  it.each([
    ["swaps a tool for another", { requirementId: 4, replaceLine: "- Packaged services with Docker", reworded: "Packaged services with Kubernetes" }, "dropped a name"],
    ["drops a number", { requirementId: 6, replaceLine: "- Built ASP.NET Core APIs serving 2M requests/day", reworded: "Built ASP.NET Core APIs for Fabrikam" }, "dropped a number"],
    ["adds a name only the requirement has", { requirementId: 4, replaceLine: "- Packaged services with Docker", reworded: "Packaged services with Docker and Kubernetes" }, "named something you did not mention"],
    ["adds a number the user did not give", { replaceLine: "- Wrote C# services", reworded: "Wrote C# services for 12 years at Fabrikam" }, "numbers you did not give"],
    ["is the same line", { replaceLine: "- Wrote C# services", reworded: "wrote c# services" }, "same as your line"],
    ["grows too much", { replaceLine: "- Wrote C# services", reworded: `Wrote C# services at Fabrikam and Contoso for 8 years${" and more".repeat(30)}` }, "too long"],
  ])("refuses a reword that %s", (_label, override, reason) => {
    const items: Record<number, ConfirmedItem> = {
      4: { requirementId: 4, requirementText: "Kubernetes", detail: "I used containers every day at work", evidence: "Packaged services with Docker" },
      5: years,
      6: { requirementId: 6, requirementText: "High-traffic APIs", detail: "Our APIs were busy at Fabrikam", evidence: "Built ASP.NET Core APIs serving 2M requests/day" },
    };
    const id = (override as { requirementId?: number }).requirementId ?? 5;
    const { text, skipped } = run(reword({ ...override, skill: "" }), items[id]!);
    expect(text).toBe(resume);
    expect(skipped).toEqual([{ requirementId: id, reason: expect.stringContaining(reason) }]);
  });
});

describe("plain text in model-written lines", () => {
  it("cleans hidden characters, curly quotes and long dashes from a new bullet and a skill", () => {
    const { text, changes } = applyAdditions(
      resume,
      [{ ...azureAddition, skill: "Azure\u200B", bullet: "Deployed APIs to Azure App Service \u2014 \u201Cfast\u201D\u200B" }],
      [azure],
    );
    expect(text).toContain('- Deployed APIs to Azure App Service - "fast"');
    expect(changes[0]).toMatchObject({ skill: "Azure", bullet: 'Deployed APIs to Azure App Service - "fast"' });
    expect(text).not.toMatch(/[\u200B\u2014\u201C\u201D]/);
  });

  it("cleans a reworded line too, and leaves the user's own lines as they are", () => {
    const curly = resume.replace("- Wrote C# services", "- Wrote C# services for Jane\u2019s team");
    const item: ConfirmedItem = { requirementId: 5, requirementText: "5+ years of C#", detail: "I used C# for 8 years at Fabrikam", evidence: "Wrote C# services" };
    const { text } = applyAdditions(
      curly,
      [{ requirementId: 5, skill: "", bullet: "", afterLine: "", replaceLine: "- Wrote C# services for Jane\u2019s team", reworded: "Wrote C# services for Jane's team \u2014 8 years at Fabrikam" }],
      [item],
    );
    expect(text).toContain("- Wrote C# services for Jane's team - 8 years at Fabrikam");
    expect(text).toContain("Fabrikam - Senior Engineer, 2019-2026");
  });
});

