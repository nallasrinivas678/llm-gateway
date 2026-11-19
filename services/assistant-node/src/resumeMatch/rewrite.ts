// Turns the skills a user confirmed into edits to their resume. The model does not rewrite the
// resume. It only suggests, per confirmed skill, a skill name, one bullet and the line to put the
// bullet under. This file makes the edits itself, so the existing lines (employers, titles, dates)
// cannot change, and refuses suggestions that bring in anything the user did not say.
import { normalizeForMatch } from "./scoring.js";

// What the model suggests for one confirmed requirement.
export interface Addition {
  requirementId: number;
  skill: string;
  bullet: string;
  afterLine: string;
}

// A requirement the user confirmed, with their own words about it.
export interface ConfirmedItem {
  requirementId: number;
  detail: string;
  requirementText: string;
}

export interface AppliedChange {
  requirementId: number;
  skill: string | null;
  bullet: string | null;
}

export interface SkippedChange {
  requirementId: number;
  reason: string;
}

const MAX_SKILL_CHARS = 60;
const MAX_BULLET_CHARS = 300;
const BULLET_LINE = /^\s*[-•*▪●]\s/;
const SKILLS_HEADING = /^(technical |core |key )?skills?:?$/i;
const SKILLS_INLINE = /^(technical |core |key )?skills?\s*:/i;
const ANY_HEADING = /^[A-Z][A-Z &/,-]+:?$/;
const FALLBACK_HEADING = "ADDITIONAL EXPERIENCE";

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

// Numbers as digits only ("2M", "2,000" and "40%" give "2", "2000" and "40"), so a figure the user
// never gave cannot slip into a bullet.
function numbersIn(text: string): string[] {
  return (text.match(/\d[\d,.]*\d|\d/g) ?? []).map((n) => n.replace(/,/g, ""));
}

// Capitalised words after the first one: names of employers, tools and products.
function namesIn(text: string): string[] {
  return text
    .split(/\s+/)
    .slice(1)
    .map((word) => word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9+#.]+$/g, ""))
    .filter((word) => /^[A-Z]/.test(word) && word.length > 1);
}

// Why a bullet cannot be used, or null when it is fine.
function bulletProblem(bullet: string, item: ConfirmedItem, resumeText: string): string | null {
  if (bullet.length > MAX_BULLET_CHARS) return "the suggested line was too long";
  const given = `${item.detail}\n${item.requirementText}`;
  const knownNumbers = new Set(numbersIn(given));
  if (numbersIn(bullet).some((n) => !knownNumbers.has(n))) return "the suggested line had numbers you did not give";
  const known = `${given}\n${resumeText}`.toLowerCase();
  if (namesIn(bullet).some((name) => !known.includes(name.toLowerCase()))) return "the suggested line named something you did not mention";
  return null;
}

// Puts a bullet at the end of the bullet list that follows `index` (or right after the line when
// no bullets follow it).
function insertAfterBlock(lines: string[], index: number, bullet: string): void {
  let at = index + 1;
  while (at < lines.length && BULLET_LINE.test(lines[at]!)) at++;
  lines.splice(at, 0, `- ${bullet}`);
}

function insertBullet(lines: string[], afterLine: string, bullet: string): void {
  const target = normalizeForMatch(afterLine);
  const found = target ? lines.findIndex((line) => normalizeForMatch(line) === target) : -1;
  if (found >= 0) return insertAfterBlock(lines, found, bullet);

  // The suggested spot does not exist, so the bullet goes under its own heading at the end.
  let heading = lines.findIndex((line) => normalizeForMatch(line) === FALLBACK_HEADING.toLowerCase());
  if (heading < 0) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
    lines.push("", FALLBACK_HEADING);
    heading = lines.length - 1;
  }
  insertAfterBlock(lines, heading, bullet);
}

function addSkills(lines: string[], skills: string[]): void {
  if (skills.length === 0) return;
  const list = skills.join(", ");
  const join = (line: string) => `${line.replace(/[\s,;.]+$/, "")}, ${list}`;

  // "Skills" on its own line, followed by the list.
  const heading = lines.findIndex((line) => SKILLS_HEADING.test(line.trim()));
  if (heading >= 0) {
    let next = heading + 1;
    while (next < lines.length && lines[next]!.trim() === "") next++;
    if (next < lines.length && !ANY_HEADING.test(lines[next]!.trim())) {
      lines[next] = join(lines[next]!);
      return;
    }
  }
  // "Skills: C#, Docker" on one line.
  const inline = lines.findIndex((line) => SKILLS_INLINE.test(line.trim()));
  if (inline >= 0) {
    lines[inline] = join(lines[inline]!);
    return;
  }
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  lines.push("", "SKILLS", list);
}

export function applyAdditions(
  resumeText: string,
  additions: Addition[],
  confirmed: ConfirmedItem[],
): { text: string; changes: AppliedChange[]; skipped: SkippedChange[] } {
  const items = new Map(confirmed.map((c) => [c.requirementId, c]));
  const lines = resumeText.split("\n");
  const resumeLower = resumeText.toLowerCase();
  const changes: AppliedChange[] = [];
  const skipped: SkippedChange[] = [];
  const skills: string[] = [];
  const done = new Set<number>();

  for (const addition of additions) {
    const item = items.get(addition.requirementId);
    // Only skills the user confirmed, once each.
    if (!item || done.has(item.requirementId)) continue;
    done.add(item.requirementId);

    const change: AppliedChange = { requirementId: item.requirementId, skill: null, bullet: null };

    // A skill name must come from the requirement or the user's own words.
    const skill = clean(addition.skill);
    const source = `${item.detail} ${item.requirementText}`.toLowerCase();
    if (skill && skill.length <= MAX_SKILL_CHARS && source.includes(skill.toLowerCase())) {
      change.skill = skill;
      if (!resumeLower.includes(skill.toLowerCase()) && !skills.some((s) => s.toLowerCase() === skill.toLowerCase())) skills.push(skill);
    }

    const bullet = clean(addition.bullet).replace(/^[-•*▪●]\s*/, "");
    if (bullet) {
      const problem = bulletProblem(bullet, item, resumeText);
      if (problem) skipped.push({ requirementId: item.requirementId, reason: problem });
      else {
        insertBullet(lines, addition.afterLine, bullet);
        change.bullet = bullet;
      }
    }
    changes.push(change);
  }

  for (const item of confirmed) {
    if (!done.has(item.requirementId)) skipped.push({ requirementId: item.requirementId, reason: "no suggestion came back for it" });
  }

  addSkills(lines, skills);
  return { text: lines.join("\n"), changes, skipped };
}
