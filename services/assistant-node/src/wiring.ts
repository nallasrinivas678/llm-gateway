// Builds the real services from the configuration. Kept out of app.ts so the routes can be tested
// with fakes, and out of index.ts so startup stays a few lines.
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseActionStore } from "./chat/actionStore.js";
import { createChatService, type ChatService } from "./chat/chatService.js";
import { createSupabaseTaskStore } from "./chat/taskTools.js";
import { createWebSearch } from "./chat/webSearch.js";
import { createSupabaseConversationStore } from "./chat/conversationStore.js";
import type { Config } from "./config.js";
import { createDailySummaryService, type DailySummaryService } from "./dailySummary/dailySummaryService.js";
import { createConnectService, type ConnectService } from "./google-oauth/connectService.js";
import { createPgTokenStore } from "./google-tokens/pgTokenStore.js";
import { createTokenService } from "./google-tokens/tokenService.js";
import { createAnswer, createAskService } from "./docQa/ask.js";
import { createEmbedder } from "./docQa/embeddings.js";
import { createIngestService } from "./docQa/ingest.js";
import type { DocServices } from "./docQa/routes.js";
import { createSupabaseDocStore } from "./docQa/store.js";
import { createGenerate } from "./resumeMatch/generate.js";
import { createMatchService, type MatchService } from "./resumeMatch/matchService.js";
import { createSupabaseMatchStore } from "./resumeMatch/matchStore.js";

export interface Services {
  chat?: ChatService;
  dailySummary?: DailySummaryService;
  googleConnect?: ConnectService;
  resumeMatch?: MatchService;
  docQa?: DocServices;
}

// The user's own token goes to Supabase, so row-level security decides what they can see.
function userClient(config: Config, anonKey: string, jwt: string) {
  return createClient(config.SUPABASE_URL, anonKey, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Resume match needs only the model and the public Supabase key (no Google account access).
function buildResumeMatch(config: Config): MatchService | undefined {
  const { GOOGLE_API_KEY, SUPABASE_ANON_KEY } = config;
  if (!GOOGLE_API_KEY || !SUPABASE_ANON_KEY) return undefined;
  const settings = config.settings.resumeMatch;
  return createMatchService({
    generate: createGenerate(
      // maxRetries 0: createGenerate does the (bounded) retrying, so tries don't multiply.
      new ChatGoogleGenerativeAI({ apiKey: GOOGLE_API_KEY, model: config.settings.chat.model, temperature: settings.temperature, maxRetries: 0 }),
      { timeoutSeconds: settings.llmTimeoutSeconds, maxRetries: settings.llmMaxRetries },
    ),
    settings,
    openStore: (userId, jwt) => createSupabaseMatchStore(userClient(config, SUPABASE_ANON_KEY, jwt), userId),
  });
}

// PDF Q&A needs the same two settings as resume match: the model key and the public Supabase key.
function buildDocQa(config: Config): DocServices | undefined {
  const { GOOGLE_API_KEY, SUPABASE_ANON_KEY } = config;
  if (!GOOGLE_API_KEY || !SUPABASE_ANON_KEY) return undefined;
  const settings = config.settings.docQa;
  const embed = createEmbedder({
    apiKey: GOOGLE_API_KEY,
    model: settings.embeddingModel,
    dimensions: settings.embeddingDimensions,
    timeoutSeconds: settings.embeddingTimeoutSeconds,
  });
  const openStore = (userId: string, jwt: string) => createSupabaseDocStore(userClient(config, SUPABASE_ANON_KEY, jwt), userId);
  return {
    ingest: createIngestService({
      openStore,
      embed,
      settings: {
        maxPages: settings.maxPages,
        maxPdfBytes: settings.maxPdfBytes,
        minTextChars: settings.minTextChars,
        chunkChars: settings.chunkChars,
        chunkOverlapChars: settings.chunkOverlapChars,
      },
    }),
    ask: createAskService({
      openStore,
      embed,
      answer: createAnswer(
        // maxRetries 0: createAnswer does the (bounded) retrying, so tries don't multiply.
        new ChatGoogleGenerativeAI({ apiKey: GOOGLE_API_KEY, model: config.settings.chat.model, temperature: settings.temperature, maxRetries: 0 }),
        { timeoutSeconds: settings.llmTimeoutSeconds, maxRetries: settings.llmMaxRetries },
      ),
      settings: { topK: settings.topK, minSimilarity: settings.minSimilarity },
    }),
  };
}

// A service whose settings are missing is left out (and the missing names are logged), so the
// rest of the service still starts and that route answers 503.
export function buildServices(config: Config): Services {
  const { SUPABASE_ANON_KEY, SUPABASE_DB_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_API_KEY } = config;
  const missing = (required: Record<string, string | undefined>) =>
    Object.entries(required).filter(([, value]) => !value).map(([name]) => name);

  const resumeMatch = buildResumeMatch(config);
  const docQa = buildDocQa(config);
  const warnResume = () => {
    if (!resumeMatch) console.warn(`Resume match is disabled. Missing settings: ${missing({ GOOGLE_API_KEY, SUPABASE_ANON_KEY }).join(", ")}`);
    if (!docQa) console.warn(`PDF Q&A is disabled. Missing settings: ${missing({ GOOGLE_API_KEY, SUPABASE_ANON_KEY }).join(", ")}`);
  };
  const withResume = (services: Services): Services => ({ ...services, ...(resumeMatch ? { resumeMatch } : {}), ...(docQa ? { docQa } : {}) });

  // What chat and the daily summary need: Google tokens and the model.
  const shared = missing({ SUPABASE_DB_URL, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_API_KEY });
  if (shared.length > 0 || !SUPABASE_DB_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_API_KEY) {
    console.warn(`Chat and daily summary are disabled. Missing settings: ${shared.join(", ")}`);
    warnResume();
    return withResume({});
  }

  const tokenStore = createPgTokenStore(SUPABASE_DB_URL, config.settings.google.requestTimeoutSeconds);
  const tokens = createTokenService({
    store: tokenStore,
    settings: config.settings.google,
    clientId: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
  });
  const getGoogleToken = (userId: string) => tokens.getAccessToken(userId);

  const { thinkingBudget } = config.settings.dailySummary;
  const dailySummary = createDailySummaryService({
    model: new ChatGoogleGenerativeAI({
      apiKey: GOOGLE_API_KEY,
      model: config.settings.chat.model,
      temperature: config.settings.chat.temperature,
      ...(thinkingBudget === undefined ? {} : { thinkingConfig: { thinkingBudget } }),
    }),
    settings: config.settings,
    getGoogleToken,
  });

  // The Connect Google flow also needs to know where Google sends the browser back to.
  let googleConnect: ConnectService | undefined;
  if (config.GOOGLE_REDIRECT_URI) {
    googleConnect = createConnectService({
      store: tokenStore,
      settings: config.settings.google,
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      redirectUri: config.GOOGLE_REDIRECT_URI,
    });
  } else {
    console.warn("Connect Google is disabled. Missing settings: GOOGLE_REDIRECT_URI");
  }

  // Chat also needs the public Supabase key to read and write conversations as the user.
  if (!SUPABASE_ANON_KEY) {
    console.warn("Chat is disabled. Missing settings: SUPABASE_ANON_KEY");
    warnResume();
    return withResume({ dailySummary, googleConnect });
  }

  const chat = createChatService({
    model: new ChatGoogleGenerativeAI({ apiKey: GOOGLE_API_KEY, model: config.settings.chat.model, temperature: config.settings.chat.temperature }),
    settings: config.settings,
    getGoogleToken,
    openTasks: (userId, jwt) => createSupabaseTaskStore(userClient(config, SUPABASE_ANON_KEY, jwt), userId),
    openActions: (userId, jwt) => createSupabaseActionStore(userClient(config, SUPABASE_ANON_KEY, jwt), userId),
    webSearch: createWebSearch({ apiKey: GOOGLE_API_KEY, model: config.settings.chat.model, ...config.settings.chat.webSearch }),
    openStore: (userId, jwt) => createSupabaseConversationStore(userClient(config, SUPABASE_ANON_KEY, jwt), userId),
  });
  return withResume({ chat, dailySummary, googleConnect });
}
