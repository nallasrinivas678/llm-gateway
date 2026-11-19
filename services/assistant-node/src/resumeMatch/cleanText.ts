// Cleans the characters that make resume text look machine-made or misbehave when pasted into an
// applicant system. Pure code, no model. This removes artifacts only; it does not reword anything.

// Invisible characters: zero-width space/joiners, word joiner, byte-order mark, Mongolian vowel
// separator, soft hyphen, and the left-to-right/right-to-left marks and embeddings.
const HIDDEN = /[\u200B-\u200D\u2060\uFEFF\u180E\u00AD\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

// Spaces that are not a plain space: no-break, ogham, en/em/thin/hair, narrow no-break, medium
// mathematical, ideographic. Tabs and newlines are left alone.
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
};

// For any resume text, the user's own included: these characters are invisible or look the same as a
// plain one, so removing them never changes what the user sees.
export function stripHiddenChars(text: string): string {
  return text
    .replace(HIDDEN, "")
    .replace(ODD_SPACES, " ")
    .replace(/[\uFB00-\uFB06]/g, (c) => LIGATURES[c] ?? c);
}

// For lines the model wrote only; the user's own lines keep their punctuation. Straight quotes, "..."
// for the ellipsis, and plain hyphens for dashes.
export function plainTypography(text: string): string {
  return stripHiddenChars(text)
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/(\d)\s*[\u2013\u2012]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2014\u2015\u2013\u2012\u2212]\s*/g, " - ")
    .replace(/ {2,}/g, " ");
}
