import { describe, expect, it } from "vitest";
import { applyAdditions, type Addition, type ConfirmedItem } from "./rewrite.js";

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
    expect(changes).toEqual([{ requirementId: 3, skill: "Azure", bullet: "Deployed APIs to Azure App Service" }]);
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

  it("puts a bullet under its own heading when the suggested line does not exist", () => {
    const { text } = applyAdditions(resume, [{ ...azureAddition, afterLine: "Some job that is not in the resume" }], [azure]);
    expect(text.endsWith("ADDITIONAL EXPERIENCE\n- Deployed APIs to Azure App Service")).toBe(true);
    // A second one joins the same heading.
    const second = applyAdditions(text, [{ requirementId: 4, skill: "Kubernetes", bullet: "Ran 12 services on Kubernetes at Contoso", afterLine: "" }], [k8s]).text;
    expect(second.match(/ADDITIONAL EXPERIENCE/g)).toHaveLength(1);
    expect(second.endsWith("- Ran 12 services on Kubernetes at Contoso")).toBe(true);
  });

  it("matches the suggested line ignoring case, spacing and dashes", () => {
    const { text } = applyAdditions(resume, [{ ...azureAddition, afterLine: "fabrikam – senior  engineer, 2019-2026" }], [azure]);
    expect(text).not.toContain("ADDITIONAL EXPERIENCE");
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
