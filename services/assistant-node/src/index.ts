import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildChatService } from "./wiring.js";

const config = loadConfig();
const app = createApp(config, { chat: buildChatService(config) });
serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`assistant-node listening on :${info.port}`);
});
