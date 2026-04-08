import { serve } from "@hono/node-server";
import { createApp } from "./server.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";

const clientManager = new CopilotClientManager();

const app = createApp({ clientManager });

const PORT = Number(process.env["PORT"] ?? 8080);

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`Server running on http://localhost:${info.port}`);
});
