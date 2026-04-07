import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "./server.js";
import { CopilotClientManager } from "./analysis/copilot-client.js";
import { JobStore, getInMemoryJobKV } from "./analyze/job-store.js";
import type { Hono } from "hono";

describe("Hono endpoints", () => {
  let app: Hono;

  beforeEach(() => {
    vi.stubEnv("SESSION_SECRET", "test-secret");
    const clientManager = new CopilotClientManager(() => ({
      chatCompletion: vi.fn(async () => ({ content: "[]" })),
      dispose: vi.fn(),
    }));
    app = createApp({
      clientManager,
      jobStore: new JobStore(getInMemoryJobKV()),
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("GET /api/health returns 200 with status ok", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("status", "ok");
  });

  it("POST /api/analyze returns 401 when not authenticated", async () => {
    const res = await app.request("/api/analyze", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toHaveProperty("error", "unauthorized");
  });
});
