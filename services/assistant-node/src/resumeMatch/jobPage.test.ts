import { describe, expect, it, vi } from "vitest";
import { JobPageError } from "./errors.js";
import { fetchJobText, htmlToText, isBlockedAddress, type LookupFn } from "./jobPage.js";

const limits = { timeoutSeconds: 5, maxBytes: 10_000, maxRedirects: 2, minJobChars: 50, maxJobChars: 2000 };
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34" }];
const posting = `<html><head><title>x</title><style>.a{}</style></head><body><script>track()</script>
<h1>Senior .NET Engineer</h1><p>We need 5+ years of C# &amp; ASP.NET Core.</p><ul><li>Azure</li><li>Kubernetes</li></ul></body></html>`;

const page = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

describe("isBlockedAddress", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "::", "fdaa:0:1::2", "fe80::1", "ff02::1", "::ffff:10.0.0.1", "not-an-ip"])(
    "blocks %s",
    (address) => expect(isBlockedAddress(address)).toBe(true),
  );

  it.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"])("allows %s", (address) =>
    expect(isBlockedAddress(address)).toBe(false),
  );
});

describe("htmlToText", () => {
  it("drops scripts and styles, keeps lines, and decodes entities", () => {
    const text = htmlToText(posting);
    expect(text).toContain("Senior .NET Engineer");
    expect(text).toContain("We need 5+ years of C# & ASP.NET Core.");
    expect(text).toContain("- Azure");
    expect(text).not.toContain("track()");
    expect(text).not.toContain(".a{}");
    expect(htmlToText("a&#39;b&#x41;&bogus;&#0;")).toBe("a'bA&bogus;");
  });
});

describe("fetchJobText", () => {
  it("reads a public posting as plain text", async () => {
    const fetch = vi.fn(async () => page(posting));
    const text = await fetchJobText("https://jobs.example.com/123", limits, { fetch, lookup: publicLookup });
    expect(text).toContain("We need 5+ years of C# & ASP.NET Core.");
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: "manual" });
  });

  it("accepts plain text pages and cuts very long text", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(3000), { headers: { "content-type": "text/plain" } }));
    expect((await fetchJobText("http://jobs.example.com/a", limits, { fetch, lookup: publicLookup })).length).toBe(2000);
  });

  it.each([
    ["ftp://jobs.example.com/a", "http and https"],
    ["https://user:pw@jobs.example.com/a", "user name or password"],
    ["https://jobs.example.com:8080/a", "standard web ports"],
    ["not a url", "web address"],
    ["http://127.0.0.1/admin", "can't be read"],
    ["http://[::1]/admin", "can't be read"],
  ])("refuses %s", async (url, message) => {
    const fetch = vi.fn();
    await expect(fetchJobText(url, limits, { fetch, lookup: publicLookup })).rejects.toThrow(message);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a host name that points into a private network", async () => {
    const lookup: LookupFn = async () => [{ address: "93.184.216.34" }, { address: "10.0.0.5" }];
    await expect(fetchJobText("https://sneaky.example.com", limits, { fetch: vi.fn(), lookup })).rejects.toThrow("can't be read");
  });

  it("explains a host that cannot be found", async () => {
    const lookup: LookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(fetchJobText("https://nope.example.com", limits, { fetch: vi.fn(), lookup })).rejects.toThrow("could not be found");
  });

  it("checks every redirect, and refuses one into a private network", async () => {
    const lookup: LookupFn = async (host) => [{ address: host === "internal.example.com" ? "10.0.0.1" : "93.184.216.34" }];
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://internal.example.com/x" } }));
    await expect(fetchJobText("https://jobs.example.com", limits, { fetch, lookup })).rejects.toThrow("can't be read");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows a public redirect", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "/jobs/123" } }))
      .mockResolvedValueOnce(page(posting));
    const text = await fetchJobText("https://jobs.example.com/old", limits, { fetch, lookup: publicLookup });
    expect(text).toContain("Senior .NET Engineer");
    expect(String(fetch.mock.calls[1]![0])).toBe("https://jobs.example.com/jobs/123");
  });

  it("stops after too many redirects", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
    await expect(fetchJobText("https://jobs.example.com", limits, { fetch, lookup: publicLookup })).rejects.toThrow("redirects too many times");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["an error status", () => page(posting, { status: 403 })],
    ["a non-text page", () => new Response("%PDF", { headers: { "content-type": "application/pdf" } })],
    ["a nearly empty page (login wall or JavaScript app)", () => page("<html><body><div id=root></div></body></html>")],
    ["a network failure", () => Promise.reject(new Error("ECONNRESET"))],
  ])("asks to paste the text instead for %s", async (_label, respond) => {
    const fetch = vi.fn(respond as () => Promise<Response>);
    const error = await fetchJobText("https://jobs.example.com", limits, { fetch, lookup: publicLookup }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobPageError);
    expect((error as Error).message).toContain("Paste the job description");
  });

  it("stops reading a page that is too large", async () => {
    const fetch = vi.fn(async () => page("<p>" + "x".repeat(20_000) + "</p>"));
    await expect(fetchJobText("https://jobs.example.com", limits, { fetch, lookup: publicLookup })).rejects.toThrow("too large");
  });
});
