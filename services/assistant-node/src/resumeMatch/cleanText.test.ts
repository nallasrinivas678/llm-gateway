import { describe, expect, it } from "vitest";
import { plainTypography, stripHiddenChars } from "./cleanText.js";

describe("stripHiddenChars", () => {
  it("removes zero-width, soft hyphen, direction and byte-order characters", () => {
    const dirty = "Led\u200B a team\u200C of\u200D 4\u2060 engi\u00ADneers\uFEFF\u200E\u202A at Fabrikam\u2069";
    expect(stripHiddenChars(dirty)).toBe("Led a team of 4 engineers at Fabrikam");
  });

  it("turns odd spaces into plain ones and keeps tabs and newlines", () => {
    expect(stripHiddenChars("Built\u00A0APIs\u202Fin\u2009C#\u3000daily\n\tSkills: C#")).toBe("Built APIs in C# daily\n\tSkills: C#");
  });

  it("turns ligature characters into letters", () => {
    expect(stripHiddenChars("e\uFB03cient \uFB01xed work\uFB02ow o\uFB00er")).toBe("efficient fixed workflow offer");
  });

  it("leaves ordinary text, including accents and curly quotes, as it is", () => {
    const text = "José\u2019s \u201Crésumé\u201D \u2014 2018\u20132021\n- Built things\u2026";
    expect(stripHiddenChars(text)).toBe(text);
  });
});

describe("plainTypography", () => {
  it("uses straight quotes and three dots", () => {
    expect(plainTypography("It\u2019s \u201Cdone\u201D\u2026")).toBe('It\'s "done"...');
  });

  it("turns long dashes into a plain hyphen with single spaces", () => {
    expect(plainTypography("Built APIs\u2014fast\u2014and safe")).toBe("Built APIs - fast - and safe");
    expect(plainTypography("Built APIs \u2014 fast")).toBe("Built APIs - fast");
    expect(plainTypography("Cut costs \u2013 a lot")).toBe("Cut costs - a lot");
  });

  it("keeps a year range tight", () => {
    expect(plainTypography("Engineer, 2018\u20132021 and 2021 \u2013 2023")).toBe("Engineer, 2018-2021 and 2021-2023");
  });

  it("also removes hidden characters, and does nothing to plain text", () => {
    expect(plainTypography("Used\u200B Docker")).toBe("Used Docker");
    expect(plainTypography("Used Docker - and C#, daily.")).toBe("Used Docker - and C#, daily.");
  });
});
