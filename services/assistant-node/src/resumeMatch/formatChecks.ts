// Readability checks on the resume text, done in plain code (no model, no quota). They answer a
// different question from the match score: not "does it fit this job" but "can an applicant system
// and a recruiter read it". They never change the score.

export interface FormatCheck {
  id: string;
  ok: boolean;
  // What was found when ok, or what to fix when not.
  message: string;
}

const EMAIL = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i;
const PHONE = /(\+?\d[\d\s().-]{8,}\d)/;
const YEAR = /\b(19|20)\d{2}\b/g;
const BULLET_LINE = /^\s*[-*•▪●◦·–]\s+\S/;

// A heading is a short line that is just the section name (any case, optional trailing colon).
const SECTIONS: { name: string; pattern: RegExp }[] = [
  { name: "Experience", pattern: /^(work |professional )?(experience|history)|^employment( history)?$/i },
  { name: "Education", pattern: /^education( and training)?$/i },
  { name: "Skills", pattern: /^(technical |key |core )?skills( summary)?$/i },
];

const MIN_WORDS = 200;
const MAX_WORDS = 1000;

export function checkFormat(text: string): FormatCheck[] {
  const lines = text.split("\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  const headings = lines.map((l) => l.trim().replace(/:$/, "")).filter((l) => l.length > 0 && l.length <= 40);
  const missingSections = SECTIONS.filter((s) => !headings.some((h) => s.pattern.test(h))).map((s) => s.name);
  const years = (text.match(YEAR) ?? []).length;
  const bullets = lines.filter((l) => BULLET_LINE.test(l)).length;
  // Text pulled from columns or tables comes out with tabs or wide gaps inside a line.
  const columnLines = lines.filter((l) => /\t/.test(l) || (l.trim().match(/\s{3,}/g) ?? []).length >= 2).length;

  return [
    {
      id: "email",
      ok: EMAIL.test(text),
      message: EMAIL.test(text) ? "Email address found." : "Add an email address near the top. Applicant systems and recruiters look for it.",
    },
    {
      id: "phone",
      ok: PHONE.test(text),
      message: PHONE.test(text) ? "Phone number found." : "Add a phone number near the top.",
    },
    {
      id: "sections",
      ok: missingSections.length === 0,
      message:
        missingSections.length === 0
          ? "Standard section headings found."
          : `Add standard headings so parsers can find them: ${missingSections.join(", ")}.`,
    },
    {
      id: "dates",
      ok: years >= 2,
      message: years >= 2 ? "Dates found." : "Add dates to each role, for example 2021 - Present.",
    },
    {
      id: "bullets",
      ok: bullets >= 3,
      message: bullets >= 3 ? "Achievements are in bullet points." : "Use bullet points for what you did in each role.",
    },
    {
      id: "length",
      ok: words >= MIN_WORDS && words <= MAX_WORDS,
      message:
        words < MIN_WORDS
          ? `The resume is short (${words} words). Add detail on your main roles.`
          : words > MAX_WORDS
            ? `The resume is long (${words} words). Aim for about two pages.`
            : `Length looks right (${words} words).`,
    },
    {
      id: "layout",
      ok: columnLines <= 2,
      message:
        columnLines <= 2
          ? "Single-column layout."
          : "Parts of the text look like columns or tables. Many applicant systems read these out of order, so use one column.",
    },
  ];
}
