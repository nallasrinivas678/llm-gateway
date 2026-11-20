// Limits how much conversation is sent to the model, without breaking what the model needs to see.
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

// The last `max` messages, starting at a message from the user. A tool result must stay with the
// model's tool call that asked for it, and the model expects the conversation to open with the
// user, so the cut moves forward to the next user message (which may leave fewer than `max`).
// The saved conversation is not changed; only what is sent is shorter.
export function trimHistory(history: BaseMessage[], max: number): BaseMessage[] {
  if (history.length <= max) return history;
  let start = history.length - max;
  while (start < history.length && !(history[start] instanceof HumanMessage)) start++;
  return history.slice(start);
}
