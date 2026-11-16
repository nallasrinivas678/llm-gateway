import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createEvent, GoogleApiError, listEvents, type FetchFn } from "./calendar.js";

interface Deps {
  fetch?: FetchFn;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
});

// Errors go back to the model as a readable message so the agent can tell the user.
// We never pass Google's response body on: it can contain details we don't want in a chat.
async function run(action: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof GoogleApiError) {
      const message =
        error.status === 401 || error.status === 403
          ? "Google rejected the request. The user may need to reconnect their Google account."
          : `Google Calendar request failed (status ${error.status}).`;
      return { ...text(message), isError: true };
    }
    throw error;
  }
}

// One server per request: the user's Google token lives only in this closure, so a tool call
// can never use another user's token.
export function createGoogleMcpServer(googleToken: string, deps: Deps = {}): McpServer {
  const fetchFn = deps.fetch ?? fetch;
  const server = new McpServer({ name: "google", version: "0.1.0" });

  server.registerTool(
    "list_events",
    {
      description: "List the user's upcoming Google Calendar events, soonest first.",
      inputSchema: { maxResults: z.number().int().min(1).max(25).default(10) },
    },
    ({ maxResults }) => run(async () => text(await listEvents(googleToken, maxResults, fetchFn))),
  );

  server.registerTool(
    "create_event",
    {
      description: "Create an event on the user's primary Google Calendar.",
      inputSchema: {
        summary: z.string().min(1).max(200),
        start: z.iso.datetime({ offset: true }).describe("ISO 8601 with offset, e.g. 2026-11-20T15:00:00-08:00"),
        end: z.iso.datetime({ offset: true }).describe("ISO 8601 with offset"),
        description: z.string().max(2000).optional(),
      },
    },
    (input) =>
      run(async () => {
        if (Date.parse(input.end) <= Date.parse(input.start)) {
          return { ...text("The event must end after it starts."), isError: true };
        }
        return text(`Created: ${JSON.stringify(await createEvent(googleToken, input, fetchFn))}`);
      }),
  );

  return server;
}
