import { createApp } from "./server.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";
import { JobStore, getInMemoryJobKV } from "./analyze/job-store.js";
import { handleAnalyzeQueue } from "./analyze/routes.js";
import type { AnalyzeQueueMessage } from "./analyze/routes.js";

const jobsKV = getInMemoryJobKV();
const jobStore = new JobStore(jobsKV);
const clientManager = new CopilotClientManager();

const app = createApp({
  clientManager,
  jobStore,
  jobsKV,
});

// ---------------------------------------------------------------------------
// Cloudflare Workers entry point
// ---------------------------------------------------------------------------
export default {
  fetch: app.fetch,

  /**
   * Queue consumer handler.
   * Cloudflare Workers will call this when messages arrive on ANALYZE_QUEUE.
   */
  async queue(batch: { messages: Array<{ body: AnalyzeQueueMessage }> }) {
    for (const msg of batch.messages) {
      await handleAnalyzeQueue(msg.body, jobStore, clientManager);
    }
  },
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
