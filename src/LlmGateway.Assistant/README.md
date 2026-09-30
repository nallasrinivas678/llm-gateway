# LlmGateway.Assistant

The tool-calling, agentic-loop orchestrator that sits **on top of** [`LlmGateway.Api`](../LlmGateway.Api) (see the root [ARCHITECTURE.md](../../ARCHITECTURE.md) for that gateway's own resilience/caching design). Where the gateway's job is "make one LLM call reliable, cheap, and observable," this project's job is "have a conversation, decide when to take actions (check a calendar, send an email, search the web), and keep doing that until it has a real answer." See [`docs/plan.md`](docs/plan.md) for the full implementation plan this was scaffolded from.

## Architecture

```
Mobile app (TaskTide)
   │  POST /assistant/chat
   │  Authorization: Bearer <supabase-jwt>
   │  { conversationId, message }
   ▼
┌───────────────────────────────────────────────────────────┐
│                  LlmGateway.Assistant                     │
│                                                             │
│  JWT bearer auth (validate signature, extract user id)     │
│                        │                                    │
│                        ▼                                    │
│  ChatController: load conversation + message history        │
│  from Supabase (Postgres), scoped to this user's token       │
│                        │                                    │
│                        ▼                                    │
│              ChatOrchestrator.RunAsync                       │
│   ┌─────────────────────────────────────────────────┐       │
│   │  append user message → call ILlmProvider          │       │
│   │        │                                           │      │
│   │  final text answer ──────┐   requests tool call(s) │      │
│   │        │                 │           │             │      │
│   │        │                 │           ▼             │      │
│   │        │                 │   ToolCallDispatcher      │     │
│   │        │                 │   (Calendar/Gmail/Docs/   │     │
│   │        │                 │    Tasks/WebSearch/...)   │     │
│   │        │                 │           │             │      │
│   │        │                 │   append tool result,     │     │
│   │        │                 │   loop back to LLM ───────┘     │
│   │        ▼                                                │  │
│   └──> return final ChatResponse                             │  │
│                        │                                    │  │
│                        ▼                                    │  │
│  Persist every NEW message this turn back to Supabase        │  │
└───────────────────────────────────────────────────────────┘
                        │
                        ▼
        reply + which tools were executed, back to the app
```

## Data models

Three layers, each shaped for a different job:

**Wire DTOs** (`Endpoints/ChatController.cs`) — what the mobile app actually sends/receives. Deliberately thin:
```csharp
record ChatRequestDto(string? ConversationId, string Message);
record ChatResponseDto(string ConversationId, string Reply, List<string> ToolCallsExecuted);
```
The client only ever sees a plain string in, plain string out — never roles, tool calls, or internal turn structure.

**`ChatMessage`** (`Models/ChatMessage.cs`) — the internal conversation record, and the one model that shows up everywhere: it's what's stored in Postgres (the `messages` table's `role`/`content`/`tool_call_id`/`tool_calls` columns map 1:1), what `ConversationSession.Messages` is a list of, and what gets sent to the LLM provider.
```csharp
public class ChatMessage
{
    public string Role { get; set; }
    public string Content { get; set; }
    public string? ToolCallId { get; set; }        // set on role="tool" - answers one ToolCallRequest
    public List<ToolCallRequest>? ToolCalls { get; set; }  // set on role="assistant" when it requested tools
}
```

**Provider-level models** (`Models/ChatRequest.cs`, `ChatResponse.cs`, `ToolSchema.cs`, `ToolCallRequest.cs`, `ToolResult.cs`) — what actually talks to Anthropic/Gemini:

```
ChatRequest                          ChatResponse
├─ Messages: List<ChatMessage>       ├─ Content: string
├─ Tools: List<ToolSchema>           └─ ToolCalls: List<ToolCallRequest>
└─ SystemPrompt: string?
```
- **`ToolSchema`** declares a tool *to* the model (name, description, JSON-schema arguments) — built from every registered `ITool` by `ToolRegistry.GetSchemas()`.
- **`ToolCallRequest`** is the model *requesting* a tool call: an id, which tool, raw `ArgumentsJson`.
- **`ToolResult`** answers one `ToolCallRequest` by id, with `IsError` if the tool failed.

## Roles: what `"user"` / `"assistant"` / `"tool"` mean

Every message is tagged with **who said it**, because that's literally part of the format every chat model is trained on — mislabel a turn and the model may think it said something it didn't.

- **`"user"`** — the human's turn.
- **`"assistant"`** — the model's turn: either a final text answer, or a turn requesting tool calls instead (that's why `ChatMessage.ToolCalls` only ever appears on assistant-role messages).
- **`"tool"`** — our own convention (not something Anthropic or Gemini natively has) for "here's what a tool returned." It exists for clarity in our own storage/dispatch logic and is enforced by the `messages` table's `check (role in ('user', 'assistant', 'tool'))` constraint.

Anthropic and Gemini don't have a wire-level "tool" role — `AnthropicProvider`/`GeminiProvider` translate ours into whatever each one actually expects:

| Our `ChatMessage.Role` | Anthropic's wire shape | Gemini's wire shape |
|---|---|---|
| `"user"` | `role: "user"`, plain content | `role: "user"`, `parts: [{text}]` |
| `"assistant"` | `role: "assistant"` | `role: "model"` (not `"assistant"`!) |
| `"assistant"` + `ToolCalls` | `role: "assistant"`, content block `{type: "tool_use", ...}` | `role: "model"`, part `{functionCall: {...}}` |
| `"tool"` | `role: "user"` (!), block `{type: "tool_result", tool_use_id, content}` | `role: "user"` (!), part `{functionResponse: {...}}` |

Both providers fold a tool result into a **user-role turn** carrying a special content block — to the model, "the tool answered" arrives structurally like "the next thing the human said," just marked as a tool result. Our `"tool"` role is a storage/dispatch convenience that gets re-expressed correctly per provider.

## Walkthrough: "What's on my calendar tomorrow?"

A concrete trace through every layer above, for a brand-new conversation.

**1. Request arrives**
```
POST /assistant/chat
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
{ "conversationId": null, "message": "What's on my calendar tomorrow?" }
```

**2. Auth (before the handler runs)** — `app.UseAuthentication()` validates the JWT's signature against `SupabaseAuth:JwtSecret`. Valid → `HttpContext.User` gets populated with the token's claims, including `sub: "3f29...-user-uuid"`.

**3. Inside `ChatController`**
```csharp
var userId = SupabaseJwtValidator.GetUserId(user);   // 3f29...-user-uuid, from the verified "sub" claim
currentUserContext.UserId = userId.Value;             // tools can now act "as" this user

var conversationId = await dataService.GetOrCreateConversationAsync(userId.Value, null, ...);
// no conversationId was sent -> INSERT INTO conversations (user_id) VALUES ($1) RETURNING id
// conversationId = "8a01...-new-conversation"

var existingMessages = await dataService.GetMessagesAsync(conversationId, ...);
// [] - brand new conversation, no history yet
```

**4. `ChatOrchestrator.RunAsync` takes over**
```csharp
session.Append(new ChatMessage { Role = "user", Content = "What's on my calendar tomorrow?" });
var tools = toolRegistry.GetSchemas();   // [list_upcoming_calendar_events, create_calendar_event, send_email, ...]
```

First call to the provider:
```json
ChatRequest {
  Messages: [ { Role: "user", Content: "What's on my calendar tomorrow?" } ],
  Tools: [ { Name: "list_upcoming_calendar_events", Description: "...", ParametersSchema: {...} }, ... ]
}
```

The model decides it needs live data rather than guessing, and responds with a tool call instead of text:
```json
ChatResponse { Content: "", ToolCalls: [ { Id: "call_1", ToolName: "list_upcoming_calendar_events", ArgumentsJson: "{\"maxResults\":10}" } ] }
```

**5. `response.HasToolCalls` is true**, so the orchestrator:
```csharp
session.Append(new ChatMessage { Role = "assistant", Content = "", ToolCalls = [...] });
var results = await dispatcher.DispatchAsync(response.ToolCalls, ...);
```
`ToolCallDispatcher` looks up `list_upcoming_calendar_events` in the registry → finds `ListUpcomingEventsTool` → it reads `currentUserContext.UserId` → calls `ICalendarConnector.ListUpcomingEventsAsync` (real Google Calendar API v3 call, using a token `GoogleOAuthService` transparently refreshed if needed) → gets back the user's actual events → serializes them to JSON as the tool result:
```json
ToolResult { ToolCallId: "call_1", Content: "[{\"summary\":\"Dentist\",\"start\":\"2026-10-01T09:00:00Z\",...}]" }
```
Appended to the session:
```csharp
session.Append(new ChatMessage { Role = "tool", ToolCallId = "call_1", Content = "[{\"summary\":\"Dentist\",...}]" });
```

**6. Loop back to the provider** — second call, now with the tool result folded in:
```json
ChatRequest {
  Messages: [
    { Role: "user", Content: "What's on my calendar tomorrow?" },
    { Role: "assistant", ToolCalls: [...] },
    { Role: "tool", ToolCallId: "call_1", Content: "[{\"summary\":\"Dentist\",...}]" }
  ],
  Tools: [...]
}
```
(Recall: for Anthropic/Gemini, that `"tool"` row is actually sent as a `role: "user"` turn with a `tool_result`/`functionResponse` block — the model just sees "here's what came back.") This time the model has what it needs and answers in plain text:
```json
ChatResponse { Content: "You have a Dentist appointment tomorrow at 9:00 AM.", ToolCalls: [] }
```
`HasToolCalls` is false, so the loop ends: `session.Append(new ChatMessage { Role = "assistant", Content = "You have a Dentist appointment tomorrow at 9:00 AM." })`, and this response is returned.

**7. Back in `ChatController`** — persist everything new this turn:
```
INSERT INTO messages (conversation_id, role, content, tool_calls) VALUES (..., 'user', 'What''s on my calendar tomorrow?', NULL);
INSERT INTO messages (...) VALUES (..., 'assistant', '', '[{"id":"call_1","toolName":"list_upcoming_calendar_events",...}]');
INSERT INTO messages (...) VALUES (..., 'tool', '[{"summary":"Dentist",...}]');   -- tool_call_id = 'call_1'
INSERT INTO messages (...) VALUES (..., 'assistant', 'You have a Dentist appointment tomorrow at 9:00 AM.', NULL);
```

**8. Response to the app**
```json
{
  "conversationId": "8a01...-new-conversation",
  "reply": "You have a Dentist appointment tomorrow at 9:00 AM.",
  "toolCallsExecuted": ["list_upcoming_calendar_events"]
}
```

The client stores `conversationId` locally; the *next* message in this thread will load these four rows back as history (step 3's `GetMessagesAsync`), and the model will have full context of the earlier exchange.
