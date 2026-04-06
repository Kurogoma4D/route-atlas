import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "./server.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";
import { JobManager } from "./analyze/job-manager.js";
import type { Express } from "express";

describe("Express endpoints", () => {
  let app: Express;

  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    const clientManager = new CopilotClientManager(() => ({
      chatCompletion: vi.fn(async () => ({ content: "[]" })),
      dispose: vi.fn(),
    }));
    app = createApp({ clientManager, jobManager: new JobManager() });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("GET /api/health returns 200 with status ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("status", "ok");
  });

  it("POST /api/analyze returns 401 when not authenticated", async () => {
    const res = await request(app).post("/api/analyze");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error", "unauthorized");
  });
});
