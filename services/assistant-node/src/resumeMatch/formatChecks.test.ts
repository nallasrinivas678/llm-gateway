import { describe, expect, it } from "vitest";
import { checkFormat } from "./formatChecks.js";

const good = [
  "Jane Sample",
  "jane@example.com | +1 512-555-0100 | Austin, TX",
  "",
  "EXPERIENCE",
  "Senior Engineer, Northwind, 2021 - Present",
  "- Built REST APIs in C# serving two million requests a day for logistics customers across the country.",
  "- Designed PostgreSQL schemas and tuned slow queries so that reports ran much faster than before.",
  "- Led a team of four engineers and ran weekly code reviews that kept quality high for every release.",
  "Engineer, Contoso, 2018 - 2021",
  "- Developed order management features and internal dashboards used by the whole support department.",
  "",
  "EDUCATION",
  "B.S. Computer Science, University of Texas, 2018",
  "",
  "SKILLS:",
  "C#, .NET, PostgreSQL, React, TypeScript",
  // Padding so the length check passes.
  ...Array.from({ length: 12 }, (_, i) => `- Delivered project ${i} with measurable results for customers, partners and the engineering organisation.`),
].join("\n");

const statusOf = (text: string) => Object.fromEntries(checkFormat(text).map((c) => [c.id, c.ok]));

describe("checkFormat", () => {
  it("passes a plain, well-formed resume", () => {
    expect(statusOf(good)).toEqual({ email: true, phone: true, sections: true, dates: true, bullets: true, length: true, layout: true });
  });

  it("says what is missing", () => {
    const checks = checkFormat("Jane Sample\nI build software.");
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(checks.filter((c) => !c.ok).map((c) => c.id)).toEqual(["email", "phone", "sections", "dates", "bullets", "length"]);
    expect(byId.sections!.message).toBe("Add standard headings so parsers can find them: Experience, Education, Skills.");
    expect(byId.length!.message).toContain("short");
  });

  it("flags a very long resume", () => {
    const long = `${good}\n${"word ".repeat(1000)}`;
    expect(checkFormat(long).find((c) => c.id === "length")).toMatchObject({ ok: false, message: expect.stringContaining("long") });
  });

  it("flags text that looks like columns or tables, but not a couple of stray gaps", () => {
    const columns = Array.from({ length: 4 }, () => "Python      Java      Go").join("\n");
    expect(statusOf(`${good}\n${columns}`).layout).toBe(false);
    expect(statusOf(`${good}\nName\tRole`).layout).toBe(true);
  });

  it("accepts common heading spellings", () => {
    const text = "Work Experience\nEmployment History\nEducation and Training\nTechnical Skills";
    expect(checkFormat(text).find((c) => c.id === "sections")!.ok).toBe(true);
  });
});
