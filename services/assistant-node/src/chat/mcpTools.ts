// Turns the tools of a connected MCP client into LangChain tools the agent can call.
//
// We do this ourselves instead of using @langchain/mcp-adapters' loadMcpTools: that function
// (version 2.0.3) needs a newer MCP client type than the SDK we install, and fails at runtime.
// Only two client methods are needed (listTools, callTool), so a small converter is simpler.
import { DynamicStructuredTool } from "@langchain/core/tools";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

type ContentBlock = { type: string; text?: string };

export async function loadMcpTools(client: Client): Promise<DynamicStructuredTool[]> {
  const { tools } = await client.listTools();
  return tools.map(
    (tool) =>
      new DynamicStructuredTool({
        name: tool.name,
        description: tool.description ?? "",
        schema: tool.inputSchema as Record<string, unknown>,
        // Errors are returned as text, not thrown, so the model reads them and can tell the user.
        func: async (args: unknown) => {
          try {
            const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> });
            return ((result.content ?? []) as ContentBlock[])
              .filter((block) => block.type === "text")
              .map((block) => block.text ?? "")
              .join("\n");
          } catch (error) {
            // Input that fails the tool's own checks; the message names the field, not any secret.
            return `The tool call failed: ${error instanceof Error ? error.message : "unknown error"}`;
          }
        },
      }),
  );
}
