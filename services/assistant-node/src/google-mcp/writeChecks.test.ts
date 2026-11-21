import { describe, expect, it } from "vitest";
import { loadSettings } from "../config.js";
import { writeProblem } from "./writeChecks.js";

const { google } = loadSettings();
const docId = "1AbCdEfGhIjKlMnOpQrSt";

describe("writeProblem", () => {
  it("accepts a good event, draft and document addition", () => {
    expect(writeProblem("create_event", { summary: "Dentist", start: "2026-11-24T09:00:00-08:00", end: "2026-11-24T10:00:00-08:00" }, google)).toBeNull();
    expect(writeProblem("create_draft", { to: "a@example.com", subject: "Hello", body: "Hi" }, google)).toBeNull();
    expect(writeProblem("append_to_doc", { documentId: docId, text: "Notes" }, google)).toBeNull();
  });

  it("refuses an event that ends before it starts, or at the same time", () => {
    const start = "2026-11-24T09:00:00-08:00";
    expect(writeProblem("create_event", { summary: "x", start, end: "2026-11-24T08:00:00-08:00" }, google)).toBe("The event must end after it starts.");
    expect(writeProblem("create_event", { summary: "x", start, end: start }, google)).toBe("The event must end after it starts.");
  });

  it("refuses a time without an offset, and a missing or empty field, naming the field and not the value", () => {
    const noOffset = writeProblem("create_event", { summary: "x", start: "2026-11-24T09:00:00", end: "2026-11-24T10:00:00-08:00" }, google);
    expect(noOffset).toMatch(/^start: /);
    expect(writeProblem("create_event", { start: "2026-11-24T09:00:00-08:00", end: "2026-11-24T10:00:00-08:00" }, google)).toMatch(/summary: /);
    const secret = writeProblem("create_draft", { to: "not an email with secret-value", subject: "s", body: "b" }, google);
    expect(secret).toMatch(/^to: /);
    expect(secret).not.toContain("secret-value");
  });

  it("refuses line breaks in a draft's subject, which could hide a recipient", () => {
    expect(writeProblem("create_draft", { to: "a@example.com", subject: "Hi\nBcc: x@example.com", body: "b" }, google)).toBe(
      "Line breaks are not allowed in the address or subject.",
    );
  });

  it("refuses text that is too long and an id that is not a Google Doc id", () => {
    expect(writeProblem("append_to_doc", { documentId: docId, text: "x".repeat(google.limits.docs.maxAppendChars + 1) }, google)).toMatch(/^text: /);
    expect(writeProblem("append_to_doc", { documentId: "../../etc/passwd-not-an-id", text: "x" }, google)).toBe("That does not look like a Google Doc id.");
  });

  it("has nothing to say about tools it does not know, so they are handled elsewhere", () => {
    expect(writeProblem("create_task", { title: "x" }, google)).toBeNull();
    expect(writeProblem("toString", {}, google)).toBeNull();
  });
});
