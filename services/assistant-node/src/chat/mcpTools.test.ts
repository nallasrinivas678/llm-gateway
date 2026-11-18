import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { loadMcpTools } from "./mcpTools.js";

// Only the two methods the converter uses.
function fakeClient(callTool: (request: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>) {
  return {
    listTools: async () => ({
      tools: [
        {
          name: "echo",
          description: "Echoes the text",
          inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        },
        { name: "no_description", inputSchema: { type: "object", properties: {} } },
      ],
    }),
    callTool,
  } as unknown as Client;
}

describe("MCP tools for the agent", () => {
  it("makes one LangChain tool per MCP tool, keeping names and descriptions", async () => {
    const tools = await loadMcpTools(fakeClient(async () => ({ content: [] })));
    expect(tools.map((t) => t.name)).toEqual(["echo", "no_description"]);
    expect(tools[0]!.description).toBe("Echoes the text");
    expect(tools[1]!.description).toBe("");
  });

  it("passes the arguments on and returns only the text blocks, joined", async () => {
    const calls: unknown[] = [];
    const client = fakeClient(async (request) => {
      calls.push(request);
      return { content: [{ type: "text", text: "one" }, { type: "image", data: "xx" }, { type: "text", text: "two" }] };
    });
    const [echo] = await loadMcpTools(client);

    expect(await echo!.invoke({ text: "hi" })).toBe("one\ntwo");
    expect(calls).toEqual([{ name: "echo", arguments: { text: "hi" } }]);
  });

  it("returns an empty string when the tool gives no content", async () => {
    const [echo] = await loadMcpTools(fakeClient(async () => ({})));
    expect(await echo!.invoke({ text: "hi" })).toBe("");
  });

  it("returns a failure as text for the model instead of throwing", async () => {
    const [echo] = await loadMcpTools(
      fakeClient(async () => {
        throw new Error("Invalid arguments");
      }),
    );
    expect(await echo!.invoke({ text: "hi" })).toBe("The tool call failed: Invalid arguments");
  });
});
