// Turns the skills a user confirmed into edits to their resume. The model does not rewrite the
// resume. It only suggests, per confirmed skill, a skill name and either one new bullet (and the
// line to put it under) or, for a requirement the resume only partly shows, a reworded version of
// that one existing line. This file makes the edits itself, so every other line (employers, titles,
// dates) cannot change, and refuses suggestions that bring in anything the user did not say.
import { plainTypography } from "./cleanText.js";
import { normalizeForMatch } from "./scoring.js";

// What the model suggests for one confirmed requirement.
export interface Addition {
  requirementId: number;
  skill: string;
  bullet: string;
  afterLine: string;
  // Reword instead of add: an exact copy of the existing line, and the new wording for it.
  replaceLine?: string;
  reworded?: string;
}

// A requirement the user confirmed, with their own words about it.
export interface ConfirmedItem {
  requirementId: number;
  detail: string;
  requirementText: string;
  // For a requirement the resume only partly shows: the resume text that partly shows it.
  evidence?: string;
}

export interface AppliedChange {
  requirementId: number;
  skill: string | null;
  bullet: string | null;
  // The new wording of an existing line, when that line was reworded.
  reworded: string | null;
}

// A bullet whose place in the resume could not be found. The user picks the role it goes under;
// code never guesses the employer, because the wrong one would be a false claim.
export interface UnplacedBullet {
  requirementId: number;
  bullet: string;
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

const BULLET_PREFIX = /^\s*[-•*▪●]\s*/;
const REWORD_MAX_GROWTH = 1.5;
const REWORD_MAX_EXTRA_CHARS = 80;

// Used only on text the model wrote: one line, no hidden characters, plain quotes and dashes.
const clean = (value: string) => plainTypography(value).replace(/\s+/g, " ").trim();

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
  // Compared in normalized form so a straight quote in the new line matches a curly one in the resume.
  const known = normalizeForMatch(`${given}\n${resumeText}`);
  if (namesIn(bullet).some((name) => !known.includes(normalizeForMatch(name)))) return "the suggested line named something you did not mention";
  return null;
}

// Why a reworded line cannot be used, or null when it is fine. Stricter than for a new bullet: the
// line must keep every number and name it had, and anything new must come from the user's own words
// (the requirement's wording is not enough, or "Azure" could be turned into "AWS").
function rewordProblem(original: string, reworded: string, item: ConfirmedItem): string | null {
  if (normalizeForMatch(reworded) === normalizeForMatch(original)) return "the reworded line was the same as your line";
  if (reworded.length > MAX_BULLET_CHARS || reworded.length > Math.max(original.length * REWORD_MAX_GROWTH, original.length + REWORD_MAX_EXTRA_CHARS)) {
    return "the reworded line was too long";
  }
  const keptNumbers = new Set(numbersIn(reworded));
  if (numbersIn(original).some((n) => !keptNumbers.has(n))) return "the reworded line dropped a number from your line";
  const rewordedNormal = normalizeForMatch(reworded);
  if (namesIn(original).some((name) => !rewordedNormal.includes(normalizeForMatch(name)))) return "the reworded line dropped a name from your line";

  const given = `${original}
${item.detail}`;
  const knownNumbers = new Set(numbersIn(given));
  if (numbersIn(reworded).some((n) => !knownNumbers.has(n))) return "the reworded line had numbers you did not give";
  const knownNormal = normalizeForMatch(given);
  if (namesIn(reworded).some((name) => !knownNormal.includes(normalizeForMatch(name)))) return "the reworded line named something you did not mention";
  return null;
}

// Replaces the line the requirement's evidence came from. Returns a reason when it cannot.
function applyReword(lines: string[], item: ConfirmedItem, replaceLine: string, rewordedRaw: string): string | null {
  const evidence = normalizeForMatch(item.evidence ?? "");
  const bare = (text: string) => normalizeForMatch(text).replace(/^[-*]\s+/, "");
  const wanted = bare(replaceLine);
  // It must be an existing line that holds the evidence: no other line (employer, dates) can change.
  const index = !evidence || !wanted ? -1 : lines.findIndex((line) => bare(line) === wanted && bare(line).includes(evidence));
  if (index < 0) return "the line to reword was not found in your resume";

  const original = lines[index]!.replace(BULLET_PREFIX, "").trim();
  const reworded = clean(rewordedRaw).replace(BULLET_PREFIX, "");
  const problem = rewordProblem(original, reworded, item);
  if (problem) return problem;
  lines[index] = `${BULLET_PREFIX.exec(lines[index]!)?.[0] ?? ""}${reworded}`;
  return null;
}

// Puts a bullet at the end of the bullet list that follows `index` (or right after the line when
// no bullets follow it).
function insertAfterBlock(lines: string[], index: number, bullet: string): void {
  let at = index + 1;
  while (at < lines.length && BULLET_LINE.test(lines[at]!)) at++;
  lines.splice(at, 0, `- ${bullet}`);
}

// False when the suggested line is not in the resume.
function insertBullet(lines: string[], afterLine: string, bullet: string): boolean {
  const target = normalizeForMatch(afterLine);
  const found = target ? lines.findIndex((line) => normalizeForMatch(line) === target) : -1;
  if (found < 0) return false;
  insertAfterBlock(lines, found, bullet);
  return true;
}

// The lines a bullet can go under: a line that is not itself a bullet or a heading and is either
// followed by a bullet or carries a date ("2019-2026", "Present"). Kept in resume order, which is
// most recent first on almost every resume.
const DATED = /\b(19|20)\d{2}\b|\bpresent\b/i;
export function roleLines(resumeText: string): string[] {
  const lines = resumeText.split("\n");
  const roles: string[] = [];
  lines.forEach((line, index) => {
    const text = line.trim();
    if (!text || BULLET_LINE.test(line) || ANY_HEADING.test(text) || SKILLS_INLINE.test(text)) return;
    let next = index + 1;
    while (next < lines.length && lines[next]!.trim() === "") next++;
    const hasBullets = next < lines.length && BULLET_LINE.test(lines[next]!);
    if ((hasBullets || DATED.test(text)) && !roles.includes(text)) roles.push(text);
  });
  return roles;
}

// Puts the bullet the user chose a role for at the end of that role's bullets. The role must be a
// line of the text, as roleLines gave it.
export function placeBullet(resumeText: string, under: string, bulletRaw: string): string {
  const bullet = clean(bulletRaw).replace(BULLET_PREFIX, "");
  const lines = resumeText.split("\n");
  const index = under.trim() === "" ? -1 : lines.findIndex((line) => line.trim() === under.trim());
  if (!bullet || bullet.length > MAX_BULLET_CHARS || index < 0) throw new RangeError("That line is not in the resume.");
  insertAfterBlock(lines, index, bullet);
  return lines.join("\n");
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
): { text: string; changes: AppliedChange[]; skipped: SkippedChange[]; unplaced: UnplacedBullet[] } {
  const items = new Map(confirmed.map((c) => [c.requirementId, c]));
  const lines = resumeText.split("\n");
  const resumeLower = resumeText.toLowerCase();
  const changes: AppliedChange[] = [];
  const skipped: SkippedChange[] = [];
  const unplaced: UnplacedBullet[] = [];
  const skills: string[] = [];
  const done = new Set<number>();

  for (const addition of additions) {
    const item = items.get(addition.requirementId);
    // Only skills the user confirmed, once each.
    if (!item || done.has(item.requirementId)) continue;
    done.add(item.requirementId);

    const change: AppliedChange = { requirementId: item.requirementId, skill: null, bullet: null, reworded: null };

    // A skill name must come from the requirement or the user's own words.
    const skill = clean(addition.skill);
    const source = `${item.detail} ${item.requirementText}`.toLowerCase();
    if (skill && skill.length <= MAX_SKILL_CHARS && source.includes(skill.toLowerCase())) {
      change.skill = skill;
      if (!resumeLower.includes(skill.toLowerCase()) && !skills.some((s) => s.toLowerCase() === skill.toLowerCase())) skills.push(skill);
    }

    // A reword replaces the existing line, so a new bullet for the same skill would repeat it.
    const rewordedRaw = clean(addition.reworded ?? "");
    let reworded = false;
    if (rewordedRaw && item.evidence) {
      const problem = applyReword(lines, item, addition.replaceLine ?? "", rewordedRaw);
      if (problem) skipped.push({ requirementId: item.requirementId, reason: problem });
      else {
        change.reworded = clean(rewordedRaw).replace(BULLET_PREFIX, "");
        reworded = true;
      }
    }

    const bullet = clean(addition.bullet).replace(/^[-•*▪●]\s*/, "");
    if (bullet && !reworded) {
      const problem = bulletProblem(bullet, item, resumeText);
      if (problem) skipped.push({ requirementId: item.requirementId, reason: problem });
      else {
        if (insertBullet(lines, addition.afterLine, bullet)) change.bullet = bullet;
        else unplaced.push({ requirementId: item.requirementId, bullet });
      }
    }
    changes.push(change);
  }

  for (const item of confirmed) {
    if (!done.has(item.requirementId)) skipped.push({ requirementId: item.requirementId, reason: "no suggestion came back for it" });
  }

  addSkills(lines, skills);
  return { text: lines.join("\n"), changes, skipped, unplaced };
}
