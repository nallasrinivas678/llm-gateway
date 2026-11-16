// Shared by the Google API wrappers. Kept free of MCP so it is easy to test.

export type FetchFn = typeof fetch;

// Carries only the product name and HTTP status. Google's response body is never kept,
// because it can contain details we don't want shown in a chat.
export class GoogleApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
  ) {
    super(`${service} request failed with status ${status}`);
  }
}

// The caller (the model) sent something we refuse to use. Safe to show back to the model.
export class InvalidInputError extends Error {}

export async function googleRequest<T>(
  service: string,
  fetchFn: FetchFn,
  url: string,
  accessToken: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetchFn(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw new GoogleApiError(service, response.status);

  return (await response.json()) as T;
}
