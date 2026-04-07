import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import session from "express-session";
import { createAuthRouter, requireAuth } from "./auth/routes.js";
import { createReposRouter } from "./repos/routes.js";
import { createAnalyzeRouter } from "./analyze/routes.js";
import type { AnalyzeRouterDeps } from "./analyze/routes.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";
import { JobManager } from "./analyze/job-manager.js";
// Session type augmentation loaded via auth/session.d.ts

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(analyzeDeps?: AnalyzeRouterDeps) {
  const app = express();

  const isProduction = process.env["NODE_ENV"] === "production";

  const frontendOrigin =
    process.env["FRONTEND_ORIGIN"] ?? "http://localhost:4200";

  app.use(
    cors({
      origin: isProduction
        ? (process.env["ALLOWED_ORIGINS"]?.split(",").map((o) => o.trim()) ??
          frontendOrigin)
        : frontendOrigin,
      credentials: true,
    }),
  );
  app.use(express.json());

  const sessionSecret = process.env["SESSION_SECRET"];
  if (!sessionSecret && process.env["NODE_ENV"] === "production") {
    throw new Error(
      "SESSION_SECRET environment variable must be set in production",
    );
  }

  app.use(
    session({
      secret: sessionSecret ?? "default-dev-secret-key",
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure:
          process.env["COOKIE_SECURE"] === "true" ||
          (process.env["COOKIE_SECURE"] === undefined &&
            (process.env["OAUTH_CALLBACK_URL"]?.startsWith("https://") ??
              false)),
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        sameSite: "lax",
      },
    }),
  );

  app.get("/api/health", (_req, res) => {
    const healthCheck: { status: string; timestamp: string } = {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
    res.json(healthCheck);
  });

  // Auth routes
  app.use("/api/auth", createAuthRouter());

  // Protected: Repository listing routes
  app.use("/api/repos", requireAuth, createReposRouter());

  // Protected: Analysis routes (SSE progress)
  // Create default deps when not provided so the default exported app
  // always registers analyze routes.
  const resolvedAnalyzeDeps: AnalyzeRouterDeps = analyzeDeps ?? {
    clientManager: new CopilotClientManager((_token) => ({
      chatCompletion: async () => ({ content: "[]" }),
      dispose: () => {},
    })),
    jobManager: new JobManager(),
  };
  app.use(
    "/api/analyze",
    requireAuth,
    createAnalyzeRouter(resolvedAnalyzeDeps),
  );

  // In production, serve Angular static files and handle SPA routing
  if (isProduction) {
    const frontendDistPath = path.resolve(
      __dirname,
      "../../frontend/dist/frontend/browser",
    );
    app.use(express.static(frontendDistPath));

    // 404 for unmatched API routes
    app.all("/api/{*path}", (_req, res) => {
      res.status(404).json({ error: "Not found" });
    });

    // SPA fallback: serve index.html for any non-API route
    app.get("{*path}", (_req, res) => {
      res.sendFile(path.join(frontendDistPath, "index.html"));
    });
  }

  return app;
}

// Default export for backward compatibility with existing tests
// Note: default app does not include analyze routes (requires CopilotClientManager)
const app = createApp();
export { app };
