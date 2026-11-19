// Reads a job posting from a URL the user gave. Many job boards (LinkedIn among them) block
// automated reading or render the posting with JavaScript; then the user pastes the text instead.
//
// The service fetches a URL chosen by a user, so it refuses addresses inside private networks.
// Otherwise it could be pointed at Fly's internal network or a cloud metadata address.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { JobPageError } from "./errors.js";
import { tidyText } from "./pdfText.js";

export interface JobFetchLimits {
  timeoutSeconds: number;
  maxBytes: number;
  maxRedirects: number;
  minJobChars: number;
  maxJobChars: number;
}

export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupFn = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

const PASTE_INSTEAD = "Couldn't read the job posting from that page. Paste the job description text instead.";

function ipv4Blocked(address: string): boolean {
  const [a = 0, b = 0] = address.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||   // carrier-grade NAT
    (a === 169 && b === 254) ||             // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))   // benchmarking
  );
}

// True for loopback, private, link-local, multicast and unspecified addresses.
export function isBlockedAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return ipv4Blocked(address);
  if (kind !== 6) return true;
  const value = address.toLowerCase();
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return ipv4Blocked(mapped[1]!);
  if (value === "::" || value === "::1") return true;
  // fc00::/7 unique local (Fly's private network is fdaa::), fe80::/10 link-local, ff00::/8 multicast.
  return /^(f[cd]|fe[89ab]|ff)/.test(value);
}

async function checkUrl(raw: string, lookup: LookupFn): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JobPageError("That doesn't look like a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new JobPageError("Only http and https addresses can be read.");
  if (url.username || url.password) throw new JobPageError("Addresses with a user name or password can't be read.");
  if (url.port && url.port !== "80" && url.port !== "443") throw new JobPageError("Only standard web ports can be read.");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host)).map((entry) => entry.address);
  } catch {
    throw new JobPageError("That website could not be found.");
  }
  if (addresses.length === 0 || addresses.some(isBlockedAddress)) throw new JobPageError("That address can't be read.");
  return url;
}

// Reads at most maxBytes, so a huge page cannot use up memory.
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) {
      await reader.cancel();
      throw new JobPageError("That page is too large to read. Paste the job description text instead.");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

// Good enough for reading a posting: drops scripts, styles and tags, keeps line structure.
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article|header|footer)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const value = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    });
  return tidyText(text);
}

export async function fetchJobText(
  rawUrl: string,
  limits: JobFetchLimits,
  deps: { fetch?: typeof fetch; lookup?: LookupFn } = {},
): Promise<string> {
  const fetchFn = deps.fetch ?? fetch;
  const lookup = deps.lookup ?? defaultLookup;
  const signal = AbortSignal.timeout(limits.timeoutSeconds * 1000);

  let url = await checkUrl(rawUrl, lookup);
  let response: Response | undefined;
  // Redirects are followed by hand so every hop is checked against private addresses.
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    try {
      response = await fetchFn(url, { redirect: "manual", signal, headers: { accept: "text/html,text/plain", "user-agent": "TaskTide-ResumeMatch/1.0" } });
    } catch {
      throw new JobPageError(PASTE_INSTEAD);
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = await checkUrl(new URL(location, url).toString(), lookup);
      response = undefined;
      continue;
    }
    break;
  }
  if (!response) throw new JobPageError("That page redirects too many times. Paste the job description text instead.");
  if (!response.ok) throw new JobPageError(PASTE_INSTEAD);

  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const isHtml = type.includes("text/html") || type.includes("application/xhtml");
  if (!isHtml && !type.includes("text/plain")) throw new JobPageError(PASTE_INSTEAD);

  const body = await readCapped(response, limits.maxBytes);
  const text = isHtml ? htmlToText(body) : tidyText(body);
  // Pages that need JavaScript or a login come back nearly empty.
  if (text.length < limits.minJobChars) throw new JobPageError(PASTE_INSTEAD);
  return text.slice(0, limits.maxJobChars);
}
