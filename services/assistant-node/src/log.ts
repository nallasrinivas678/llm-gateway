// One JSON line per event, with a fixed set of fields. An error is described by its type, and its
// HTTP status or error code when it has one. Its message is never logged: messages from the
// database, Google and the model can quote what the user wrote or the account's data.

function describeError(error: unknown): Record<string, string | number> {
  if (!(error instanceof Error)) return { error: "unknown" };
  const { status, code } = error as { status?: unknown; code?: unknown };
  return {
    error: error.name,
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" || typeof code === "number" ? { code: String(code).slice(0, 40) } : {}),
  };
}

export function logError(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: "error", event, ...describeError(error) }));
}

// Only numbers, booleans and short fixed words belong in `fields`: never user text.
export function logInfo(event: string, fields: Record<string, number | boolean | string> = {}): void {
  console.info(JSON.stringify({ level: "info", event, ...fields }));
}
