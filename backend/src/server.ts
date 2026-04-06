import express from "express";
import cors from "cors";
import session from "express-session";
import type { AnalysisResult } from "@route-atlas/shared";
import { createAuthRouter, requireAuth } from "./auth/routes.js";
import { createReposRouter } from "./repos/routes.js";
// Session type augmentation loaded via auth/session.d.ts

export function createApp() {
  const app = express();

  const frontendOrigin =
    process.env["FRONTEND_ORIGIN"] ?? "http://localhost:4200";

  app.use(
    cors({
      origin: frontendOrigin,
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
        secure: process.env["NODE_ENV"] === "production",
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

  // Protected: Placeholder endpoint for future analysis feature
  app.post("/api/analyze", requireAuth, (_req, res) => {
    const placeholder: AnalysisResult = {
      framework: "unknown",
      screens: [],
      transitions: [],
    };
    res.json(placeholder);
  });

  return app;
}

// Default export for backward compatibility with existing tests
const app = createApp();
export { app };
