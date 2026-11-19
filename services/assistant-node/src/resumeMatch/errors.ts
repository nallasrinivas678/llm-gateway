// Errors whose message is written for the user and safe to show as `detail`.
// Anything else is logged (without document text) and replaced by a generic message.

// The uploaded or pasted input cannot be used (wrong file, too long, no text layer...).
export class ResumeInputError extends Error {}

// A job page could not be read; the user can paste the text instead.
export class JobPageError extends Error {}

// Another version was saved first (for example from a second tab); the user must reload.
export class VersionConflictError extends Error {
  constructor() {
    super("This resume match has a newer version. Reload it and try again.");
  }
}

// The match does not exist or belongs to someone else (the two look the same on purpose).
export class MatchNotFoundError extends Error {
  constructor() {
    super("Resume match not found.");
  }
}
