import { createApp } from "./server.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";
import { JobManager } from "./analyze/job-manager.js";

const app = createApp({
  clientManager: new CopilotClientManager(),
  jobManager: new JobManager(),
});

// ---------------------------------------------------------------------------
// Cloudflare Workers entry point
// ---------------------------------------------------------------------------
export default {
  fetch: app.fetch,
};

// ---------------------------------------------------------------------------
// Local development: start a Node.js HTTP server when run directly.
// In Cloudflare Workers, navigator.userAgent is "Cloudflare-Workers".
// ---------------------------------------------------------------------------
const isWorkers =
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

if (!isWorkers) {
  try {
    const PORT = process.env?.["PORT"] ?? 3000;
    const { serve } = await import("@hono/node-server");
    serve({ fetch: app.fetch, port: Number(PORT) }, (info) => {
      console.log(`Server running on http://localhost:${info.port}`);
    });
  } catch {
    // Ignore — module resolution may fail in non-Node runtimes
  }
}
