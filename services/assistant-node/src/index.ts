import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
serve({ fetch: createApp(config).fetch, port: config.PORT }, (info) => {
  console.log(`assistant-node listening on :${info.port}`);
});
