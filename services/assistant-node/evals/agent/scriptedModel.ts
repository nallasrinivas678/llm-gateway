// A stand-in for the model that does exactly what a scenario says, call by call, whatever it is
// shown. This is how the harness tier plays out the worst case: a model that obeys an injected
// instruction, asks for a tool that does not exist, or never stops calling tools.
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ChatResult } from "@langchain/core/outputs";
import type { ScriptStep } from "./types.js";

export class ScriptedModel extends BaseChatModel {
  calls = 0;
  private callId = 0;

  constructor(private readonly script: ScriptStep[]) {
    super({});
  }

  _llmType() {
    return "scripted";
  }

  // The agent calls this to attach tools; the script ignores them but it must stay the same object.
  bindTools() {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    // After the script runs out, the model keeps doing its last step (this is how "never stops" is written).
    const step = this.script[Math.min(this.calls++, this.script.length - 1)]!;
    const message =
      "say" in step
        ? new AIMessage(step.say)
        : new AIMessage({ content: "", tool_calls: step.call.map((c) => ({ id: `call-${++this.callId}`, name: c.name, args: c.args, type: "tool_call" as const })) });
    return { generations: [{ message, text: "say" in step ? step.say : "" }] };
  }
}
