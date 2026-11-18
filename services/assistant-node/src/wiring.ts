// Builds the real services from the configuration. Kept out of app.ts so the routes can be tested
// with fakes, and out of index.ts so startup stays a few lines.
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createClient } from "@supabase/supabase-js";
import { createChatService, type ChatService } from "./chat/chatService.js";
import { createSupabaseConversationStore } from "./chat/conversationStore.js";
import type { Config } from "./config.js";
import { createDailySummaryService, type DailySummaryService } from "./dailySummary/dailySummaryService.js";
import { createPgTokenStore } from "./google-tokens/pgTokenStore.js";
import { createTokenService } from "./google-tokens/tokenService.js";

export interface Services {
  chat?: ChatService;
  dailySummary?: DailySummaryService;
}

// A service whose settings are missing is left out (and the missing names are logged), so the
// rest of the service still starts and that route answers 503.
export function buildServices(config: Config): Services {
  const { SUPABASE_ANON_KEY, SUPABASE_DB_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_API_KEY } = config;
  const missing = (required: Record<string, string | undefined>) =>
    Object.entries(required).filter(([, value]) => !value).map(([name]) => name);

  // What both features need: Google tokens and the model.
  const shared = missing({ SUPABASE_DB_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_API_KEY });
  if (shared.length > 0 || !SUPABASE_DB_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_API_KEY) {
    console.warn(`Chat and daily summary are disabled. Missing settings: ${shared.join(", ")}`);
    return {};
  }

  const tokens = createTokenService({
    store: createPgTokenStore(SUPABASE_DB_URL),
    settings: config.settings.google,
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
  });
  const getGoogleToken = (userId: string) => tokens.getAccessToken(userId);

  const dailySummary = createDailySummaryService({
    model: new ChatGoogleGenerativeAI({ apiKey: GOOGLE_API_KEY, model: config.settings.chat.model, temperature: config.settings.chat.temperature }),
    settings: config.settings,
    getGoogleToken,
  });

  // Chat also needs the public Supabase key to read and write conversations as the user.
  if (!SUPABASE_ANON_KEY) {
    console.warn("Chat is disabled. Missing settings: SUPABASE_ANON_KEY");
    return { dailySummary };
  }

  const chat = createChatService({
    model: new ChatGoogleGenerativeAI({ apiKey: GOOGLE_API_KEY, model: config.settings.chat.model, temperature: config.settings.chat.temperature }),
    settings: config.settings,
    getGoogleToken,
    // The user's own token goes to Supabase, so row-level security decides what they can see.
    openStore: (userId, jwt) =>
      createSupabaseConversationStore(
        createClient(config.SUPABASE_URL, SUPABASE_ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${jwt}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        }),
        userId,
      ),
  });
  return { chat, dailySummary };
}
