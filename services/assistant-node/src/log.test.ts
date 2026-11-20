import { afterEach, describe, expect, it, vi } from "vitest";
import { logError, logInfo } from "./log.js";

afterEach(() => vi.restoreAllMocks());

const lastLine = (spy: ReturnType<typeof vi.spyOn>) => JSON.parse(String(spy.mock.calls.at(-1)![0])) as Record<string, unknown>;

describe("logError", () => {
  it("logs the type, status and code of an error as one JSON line, and never its message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("pdf ask failed", Object.assign(new Error("user asked about alice@example.com"), { name: "ApiError", status: 429, code: "RESOURCE_EXHAUSTED" }));
    expect(lastLine(spy)).toEqual({ level: "error", event: "pdf ask failed", error: "ApiError", status: 429, code: "RESOURCE_EXHAUSTED" });
    expect(String(spy.mock.calls[0]![0])).not.toContain("alice");
  });

  it("describes something that is not an Error without anything from it", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logError("chat failed", "the user said secret things");
    expect(lastLine(spy)).toEqual({ level: "error", event: "chat failed", error: "unknown" });
    logError("chat failed", Object.assign(new Error("x"), { status: "500", code: {} }));
    expect(lastLine(spy)).toEqual({ level: "error", event: "chat failed", error: "Error" });
  });
});

describe("logInfo", () => {
  it("logs the given fields", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    logInfo("doc ask", { retrieved: 6, relevant: 4 });
    expect(lastLine(spy)).toEqual({ level: "info", event: "doc ask", retrieved: 6, relevant: 4 });
  });
});
