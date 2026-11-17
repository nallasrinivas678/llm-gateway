// Builds the real services from the configuration. Kept out of app.ts so the routes can be tested
// with fakes, and out of index.ts so startup stays a few lines.
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createClient } from "@supabase/supabase-js";
import { createChatService, type ChatService } from "./chat/chatService.js";
import { createSupabaseConversationStore } from "./chat/conversationStore.js";
import type { Config } from "./config.js";
import { createPgTokenStore } from "./google-tokens/pgTokenStore.js";
import { createTokenService } from "./google-tokens/tokenService.js";

// Returns undefined, and says which settings are missing, when chat cannot be built.
export function buildChatService(config: Config): ChatService | undefined {
  const { SUPABASE_ANON_KEY, SUPABASE_DB_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_API_KEY } = config;
  const missing = Object.entries({ SUPABASE_ANON_KEY, SUPABASE_DB_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_API_KEY })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0 || !SUPABASE_ANON_KEY || !SUPABASE_DB_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_API_KEY) {
    console.warn(`Chat is disabled. Missing settings: ${missing.join(", ")}`);
    return undefined;
  }

  const tokens = createTokenService({
    store: createPgTokenStore(SUPABASE_DB_URL),
    settings: config.settings.google,
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
  });

  return createChatService({
    model: new ChatGoogleGenerativeAI({
      apiKey: GOOGLE_API_KEY,
      model: config.settings.chat.model,
      temperature: config.settings.chat.temperature,
    }),
    settings: config.settings,
    getGoogleToken: (userId) => tokens.getAccessToken(userId),
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
}
