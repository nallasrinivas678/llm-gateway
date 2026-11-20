import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { trimHistory } from "./history.js";

const human = (text: string) => new HumanMessage(text);
const ai = (text: string) => new AIMessage(text);
const call = (id: string) => new AIMessage({ content: "", tool_calls: [{ id, name: "list_events", args: {}, type: "tool_call" }] });
const result = (id: string) => new ToolMessage({ content: "[]", tool_call_id: id });
const texts = (messages: BaseMessage[]) => messages.map((m) => String(m.content));

describe("trimHistory", () => {
  it("leaves a short conversation alone", () => {
    const history = [human("a"), ai("b")];
    expect(trimHistory(history, 10)).toBe(history);
  });

  it("keeps the last messages, starting at a user message", () => {
    const history = [human("q1"), ai("a1"), human("q2"), ai("a2"), human("q3"), ai("a3")];
    expect(texts(trimHistory(history, 3))).toEqual(["q3", "a3"]);
    expect(texts(trimHistory(history, 4))).toEqual(["q2", "a2", "q3", "a3"]);
  });

  it("never starts with a tool result or the middle of a tool call", () => {
    const history = [human("q1"), call("c1"), result("c1"), ai("a1"), human("q2"), call("c2"), result("c2"), ai("a2")];
    // A cut of 5 would start at the result of the first call; it moves on to the next user message.
    const trimmed = trimHistory(history, 5);
    expect(texts(trimmed)[0]).toBe("q2");
    for (const [index, message] of trimmed.entries()) {
      if (message instanceof ToolMessage) expect(trimmed[index - 1]).toBeInstanceOf(AIMessage);
    }
    expect(trimmed).toHaveLength(4);
  });

  it("sends nothing from the past when no user message is left in the window", () => {
    const history = [human("q1"), call("c1"), result("c1"), ai("a1"), ai("more")];
    expect(trimHistory(history, 2)).toEqual([]);
  });
});
