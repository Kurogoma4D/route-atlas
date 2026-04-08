import { Hono } from "hono";
import { cors } from "hono/cors";
import { createAuthRouter, requireAuth } from "./auth/routes.js";
import { createReposRouter } from "./repos/routes.js";
import { createAnalyzeRouter } from "./analyze/routes.js";
import type { AnalyzeRouterDeps } from "./analyze/routes.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";
import { JobStore, getInMemoryJobKV } from "./analyze/job-store.js";
import { sessionMiddleware } from "./auth/session.js";

export function createApp(analyzeDeps?: AnalyzeRouterDeps): Hono {
  const app = new Hono();

  const isProduction = process.env["NODE_ENV"] === "production";

  const frontendOrigin =
    process.env["FRONTEND_ORIGIN"] || "http://localhost:4200";

  const envOrigins = process.env["ALLOWED_ORIGINS"]
    ?.split(",")
    .map((o) => o.trim());

  const allowedOrigins: string[] =
    isProduction && envOrigins ? envOrigins : [frontendOrigin];

  app.use(
    "/*",
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );

  // Session middleware (cookie-based, in-memory store)
  app.use("/*", sessionMiddleware());

  // Health check
  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  });

  // Auth routes
  const authRouter = createAuthRouter();
  app.route("/api/auth", authRouter);

  // Protected: Repository listing routes
  const reposRouter = new Hono();
  reposRouter.use("/*", requireAuth);
  reposRouter.route("/", createReposRouter());
  app.route("/api/repos", reposRouter);

  // Protected: Analysis routes (polling-based progress)
  const resolvedAnalyzeDeps: AnalyzeRouterDeps = analyzeDeps ?? {
    clientManager: new CopilotClientManager((_token) => ({
      chatCompletion: async () => ({ content: "[]" }),
      dispose: () => {},
    })),
    jobStore: new JobStore(getInMemoryJobKV()),
  };
  const analyzeRouter = new Hono();
  analyzeRouter.use("/*", requireAuth);
  analyzeRouter.route("/", createAnalyzeRouter(resolvedAnalyzeDeps));
  app.route("/api/analyze", analyzeRouter);

  // 404 for unmatched API routes
  app.all("/api/*", (c) => {
    return c.json({ error: "Not found" }, 404);
  });

  return app;
}

// Default export for backward compatibility with existing tests
const app: Hono = createApp();
export { app };
