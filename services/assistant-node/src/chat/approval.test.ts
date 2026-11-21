import { DynamicStructuredTool } from "@langchain/core/tools";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isFailureText, previewFor, withApproval, WRITE_TOOLS, type ApprovalHooks } from "./approval.js";
import { buildSystemPrompt } from "./systemPrompt.js";

describe("previewFor", () => {
  it.each([
    ["create_task", { title: "Pay rent", dueDate: "2026-11-24" }, undefined, 'Add the task "Pay rent" due 2026-11-24'],
    ["create_task", { title: "Pay rent", dueDate: "2026-11-24", priority: "high" }, undefined, 'Add the task "Pay rent" due 2026-11-24, high priority'],
    ["create_task", { title: "Pay rent", dueDate: "2026-11-24", priority: "none" }, undefined, 'Add the task "Pay rent" due 2026-11-24'],
    ["complete_task", { taskId: "x" }, "Pay rent", 'Mark the task "Pay rent" done'],
    ["complete_task", { taskId: "x", occurrenceDate: "2026-11-24" }, "Pay rent", 'Mark the task "Pay rent" done for 2026-11-24'],
    ["create_event", { summary: "Dentist", start: "2026-11-24T09:00:00-08:00", end: "2026-11-24T10:00:00-08:00" }, undefined, 'Add the calendar event "Dentist" from 2026-11-24T09:00:00-08:00 to 2026-11-24T10:00:00-08:00'],
    ["create_draft", { to: "a@example.com", subject: "Hello", body: "..." }, undefined, 'Save an email draft to a@example.com, subject "Hello" (it is not sent)'],
    ["append_to_doc", { documentId: "d", text: "Notes" }, undefined, 'Add to the end of a Google Doc: "Notes"'],
    ["something_new", {}, undefined, "Run something_new"],
  ])("%s", (tool, args, title, expected) => {
    expect(previewFor(tool, args, title)).toBe(expected);
  });

  it("shows only the first words of a long text, on one line", () => {
    const preview = previewFor("append_to_doc", { documentId: "d", text: `line one\n\nline two ${"x".repeat(300)}` });
    expect(preview).not.toContain("\n");
    expect(preview.length).toBeLessThan(160);
    expect(preview).toContain("...");
  });
});

describe("what counts as a write", () => {
  it("covers every tool that changes something, and none that only reads", () => {
    expect([...WRITE_TOOLS].sort()).toEqual(["append_to_doc", "complete_task", "create_draft", "create_event", "create_task"]);
    for (const reader of ["list_events", "search_emails", "read_doc", "list_tasks", "web_search"]) expect(WRITE_TOOLS.has(reader)).toBe(false);
  });

  it("recognises the failure wordings the tools use", () => {
    for (const text of ["The tool call failed: Google Calendar request failed (status 403).", "The task tool failed. Tell the user tasks are unavailable right now.", "No task with that id was found."]) {
      expect(isFailureText(text)).toBe(true);
    }
    for (const text of ['Created the task "Pay rent" due 2026-11-24 (id t-1).', "Draft created (id d1). It has not been sent.", "Created: {}"]) {
      expect(isFailureText(text)).toBe(false);
    }
  });
});

describe("withApproval", () => {
  const ran: string[] = [];
  const tool = (name: string) =>
    new DynamicStructuredTool({
      name,
      description: `does ${name}`,
      schema: z.object({ title: z.string() }),
      func: async ({ title }) => (ran.push(name), `ran ${name} ${title}`),
    });
  const hooks = (overrides: Partial<ApprovalHooks> = {}) => {
    const proposed: { tool: string; args: unknown; preview: string }[] = [];
    const cards: unknown[] = [];
    const value: ApprovalHooks = {
      describe: async (name) => ({ preview: `preview of ${name}` }),
      propose: async (name, args, preview) => (proposed.push({ tool: name, args, preview }), { id: "a1", tool: name, preview }),
      onProposed: (card) => cards.push(card),
      ...overrides,
    };
    return { value, proposed, cards };
  };

  it("leaves a reading tool alone and turns a writing one into a proposal", async () => {
    ran.length = 0;
    const { value, proposed, cards } = hooks();
    const [reader, writer] = withApproval([tool("list_tasks"), tool("create_task")], value);

    expect(await reader!.invoke({ title: "x" })).toBe("ran list_tasks x");
    const answer = await writer!.invoke({ title: "x" });

    expect(ran).toEqual(["list_tasks"]); // the writing tool never ran
    expect(answer).toContain("waiting for the user's approval");
    expect(answer).toContain("NOT been made");
    expect(proposed).toEqual([{ tool: "create_task", args: { title: "x" }, preview: "preview of create_task" }]);
    expect(cards).toEqual([{ id: "a1", tool: "create_task", preview: "preview of create_task" }]);
  });

  it("keeps the name, description and schema, so the model sees the same tool", () => {
    const original = tool("create_event");
    const [wrapped] = withApproval([original], hooks().value);
    expect(wrapped!.name).toBe("create_event");
    expect(wrapped!.description).toBe(original.description);
    expect(JSON.stringify(wrapped!.schema)).toBe(JSON.stringify(original.schema));
  });

  it("passes the model's refusal text on and proposes nothing", async () => {
    const { value, proposed } = hooks({ describe: async () => ({ refusal: "No task with that id was found." }) });
    const [writer] = withApproval([tool("complete_task")], value);
    expect(await writer!.invoke({ title: "x" })).toBe("No task with that id was found.");
    expect(proposed).toEqual([]);
  });
});

describe("system prompt", () => {
  it("explains approval only when it is on", () => {
    expect(buildSystemPrompt({ today: "2026-11-20", googleConnected: true, approval: true })).toContain("approval");
    expect(buildSystemPrompt({ today: "2026-11-20", googleConnected: true })).not.toContain("approval");
  });
});
