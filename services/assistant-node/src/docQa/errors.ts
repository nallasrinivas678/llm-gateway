// Errors the PDF Q&A routes turn into status codes.

// The document does not exist or is not the caller's (row-level security hides other users' rows).
export class DocNotFoundError extends Error {
  constructor() {
    super("Document not found.");
    this.name = "DocNotFoundError";
  }
}

// The document is not ready to be asked about.
export class DocNotReadyError extends Error {
  constructor(public readonly status: string) {
    super(`Document is ${status}; ask again once it is ready.`);
    this.name = "DocNotReadyError";
  }
}

// Ingest is already running for this document on this machine.
export class DocBusyError extends Error {
  constructor() {
    super("This document is already being processed.");
    this.name = "DocBusyError";
  }
}

// A problem with the PDF itself. The message is safe to show and is saved on the document.
export class DocInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocInputError";
  }
}
