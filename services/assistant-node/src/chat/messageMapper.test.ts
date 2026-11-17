import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { messageToStored, messagesToStored, rowToMessage } from "./messageMapper.js";

describe("rowToMessage", () => {
  it("reads a user row", () => {
    const message = rowToMessage({ role: "user", content: "hi", tool_call_id: null, tool_calls: null });
    expect(message).toBeInstanceOf(HumanMessage);
    expect(message.content).toBe("hi");
  });

  it("reads an assistant row with the .NET tool-call format and parses the arguments", () => {
    const message = rowToMessage({
      role: "assistant",
      content: "",
      tool_call_id: null,
      tool_calls: [{ Id: "c1", ToolName: "list_events", ArgumentsJson: '{"maxResults":3}' }],
    }) as AIMessage;
    expect(message.tool_calls).toEqual([{ id: "c1", name: "list_events", args: { maxResults: 3 }, type: "tool_call" }]);
  });

  it("also accepts camelCase keys", () => {
    const message = rowToMessage({
      role: "assistant",
      content: "",
      tool_call_id: null,
      tool_calls: [{ id: "c1", toolName: "list_events", argumentsJson: "{}" }],
    }) as AIMessage;
    expect(message.tool_calls?.[0]).toMatchObject({ id: "c1", name: "list_events", args: {} });
  });

  it("treats broken argument JSON as no arguments instead of failing the whole conversation", () => {
    const message = rowToMessage({
      role: "assistant",
      content: "",
      tool_call_id: null,
      tool_calls: [{ Id: "c1", ToolName: "t", ArgumentsJson: "{not json" }],
    }) as AIMessage;
    expect(message.tool_calls?.[0]?.args).toEqual({});
  });

  it("reads a tool row with its call id", () => {
    const message = rowToMessage({ role: "tool", content: "result", tool_call_id: "c1", tool_calls: null }) as ToolMessage;
    expect(message).toBeInstanceOf(ToolMessage);
    expect(message.tool_call_id).toBe("c1");
  });

  it("rejects an unknown role", () => {
    expect(() => rowToMessage({ role: "system", content: "x", tool_call_id: null, tool_calls: null })).toThrow(/Unknown message role/);
  });
});

describe("messageToStored", () => {
  it("writes tool calls in the .NET format (PascalCase keys, arguments as a JSON string)", () => {
    const stored = messageToStored(
      new AIMessage({ content: "", tool_calls: [{ id: "c1", name: "list_events", args: { maxResults: 3 }, type: "tool_call" }] }),
    );
    expect(stored).toEqual({
      role: "assistant",
      content: "",
      toolCallId: null,
      toolCalls: [{ Id: "c1", ToolName: "list_events", ArgumentsJson: '{"maxResults":3}' }],
    });
  });

  it("stores no tool calls as null, not an empty list", () => {
    expect(messageToStored(new AIMessage("hello"))?.toolCalls).toBeNull();
  });

  it("stores user and tool messages", () => {
    expect(messageToStored(new HumanMessage("hi"))).toEqual({ role: "user", content: "hi", toolCallId: null, toolCalls: null });
    expect(messageToStored(new ToolMessage({ content: "r", tool_call_id: "c1" }))).toEqual({
      role: "tool",
      content: "r",
      toolCallId: "c1",
      toolCalls: null,
    });
  });

  it("keeps only the text of a message made of content blocks", () => {
    const stored = messageToStored(new AIMessage({ content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] }));
    expect(stored?.content).toBe("Hello world");
  });

  it("does not store system messages", () => {
    expect(messageToStored(new SystemMessage("rules"))).toBeNull();
    expect(messagesToStored([new SystemMessage("rules"), new HumanMessage("hi")])).toHaveLength(1);
  });

  it("survives a round trip", () => {
    const original = new AIMessage({ content: "ok", tool_calls: [{ id: "c9", name: "create_draft", args: { to: "a@b.co" }, type: "tool_call" }] });
    const stored = messageToStored(original)!;
    const back = rowToMessage({ role: stored.role, content: stored.content, tool_call_id: stored.toolCallId, tool_calls: stored.toolCalls }) as AIMessage;
    expect(back.tool_calls).toEqual(original.tool_calls);
    expect(back.content).toBe("ok");
  });
});
