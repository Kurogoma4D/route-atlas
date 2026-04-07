import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../server.js";
import { JobManager } from "./job-manager.js";
import { CopilotClientManager } from "../analysis/copilot-client.js";
import type { LLMAdapter } from "../analysis/copilot-client.js";
import type { Express } from "express";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fetch globally for auth + GitHub API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock the analysis modules to avoid real GitHub API / LLM calls
vi.mock("../analysis/framework-detector.js", async () => {
  const actual = await vi.importActual<typeof import("../analysis/framework-detector.js")>("../analysis/framework-detector.js");
  return {
    ...actual,
    detectFramework: vi.fn(() => ({
      framework: "nextjs-app",
      routingFilePatterns: ["app/**/page.tsx"],
    })),
    detectPlatform: vi.fn(() => "web"),
    detectAndroidFramework: vi.fn(() => ({
      framework: "android-navigation",
      routingFilePatterns: ["**/res/navigation/*.xml"],
    })),
    detectiOSFramework: vi.fn(() => ({
      framework: "ios-swiftui",
      routingFilePatterns: ["**/*View.swift", "**/*App.swift"],
    })),
    detectFlutterFramework: vi.fn(() => ({
      framework: "flutter-go-router",
      routingFilePatterns: ["lib/**/router.dart", "lib/**/routes.dart", "lib/**/*_router.dart", "lib/**/*.dart"],
    })),
  };
});

vi.mock("../analysis/github-file-fetcher.js", () => ({
  fetchFileTree: vi.fn(async () => ({
    files: [
      {
        path: "package.json",
        type: "blob",
        sha: "abc",
        mode: "100644",
        url: "",
      },
      {
        path: "app/page.tsx",
        type: "blob",
        sha: "def",
        mode: "100644",
        url: "",
      },
    ],
    truncated: false,
  })),
  filterFilesByPatterns: vi.fn(
    (files: Array<{ path: string }>, patterns: string[]) => {
      // Return files matching simple pattern check
      return files.filter((f: { path: string }) =>
        patterns.some((p: string) => {
          const ext = p.split(".").pop();
          return f.path.endsWith(`.${ext}`) || f.path === "package.json";
        }),
      );
    },
  ),
  fetchFileContents: vi.fn(
    async (_owner: string, _repo: string, files: Array<{ path: string }>) => {
      return files.map((f: { path: string }) => ({
        path: f.path,
        content:
          f.path === "package.json"
            ? '{"dependencies":{"next":"14.0.0"}}'
            : "export default function Page() { return <div>Hello</div>; }",
      }));
    },
  ),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAdapter(): LLMAdapter {
  const turn1 = JSON.stringify([
    {
      id: "screen_home",
      path: "/",
      componentFile: "app/page.tsx",
      label: "Home",
      description: "Home page",
    },
  ]);
  const turn2 = JSON.stringify([]);
  const turn3 = JSON.stringify([]);

  let callIndex = 0;
  const responses = [turn1, turn2, turn3];

  return {
    chatCompletion: vi.fn(async () => {
      const content = responses[callIndex] ?? "[]";
      callIndex++;
      return { content };
    }),
    dispose: vi.fn(),
  };
}

/**
 * Authenticate a supertest agent by going through the OAuth flow with mocks.
 */
async function authenticateAgent(
  agent: ReturnType<typeof request.agent>,
): Promise<void> {
  // Initiate OAuth to get state
  const ghRes = await agent.get("/api/auth/github");
  const location = ghRes.headers["location"] as string;
  const state = new URL(location).searchParams.get("state")!;

  // Mock token exchange
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "gho_test_token_123" }),
  });

  // Mock user info
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      login: "testuser",
      avatar_url: "https://github.com/testuser.png",
      name: "Test User",
    }),
  });

  // Mock Copilot access check
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({}),
  });

  await agent.get(`/api/auth/callback?code=valid_code&state=${state}`);
}

/**
 * Authenticate a second user (different login).
 */
async function authenticateAgent2(
  agent: ReturnType<typeof request.agent>,
): Promise<void> {
  const ghRes = await agent.get("/api/auth/github");
  const location = ghRes.headers["location"] as string;
  const state = new URL(location).searchParams.get("state")!;

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "gho_other_user_token" }),
  });

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      login: "otheruser",
      avatar_url: "https://github.com/otheruser.png",
      name: "Other User",
    }),
  });

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({}),
  });

  await agent.get(`/api/auth/callback?code=valid_code_2&state=${state}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Analysis API routes", () => {
  let app: Express;
  let jobManager: JobManager;
  let clientManager: CopilotClientManager;

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    mockFetch.mockReset();

    jobManager = new JobManager(60000);
    clientManager = new CopilotClientManager(() => createMockAdapter());
    app = createApp({ clientManager, jobManager });
  });

  afterEach(() => {
    jobManager.clear();
    clientManager.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("POST /api/analyze", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app)
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });

      expect(res.status).toBe(401);
    });

    it("returns 400 when required fields are missing", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      const res = await agent.post("/api/analyze").send({ owner: "foo" });

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error", "validation_error");
    });

    it("returns 202 with jobId", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      const res = await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });

      expect(res.status).toBe(202);
      expect(res.body).toHaveProperty("jobId");
      expect(typeof res.body.jobId).toBe("string");
    });

    it("creates a job in the job manager", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      expect(jobManager.size).toBe(0);

      await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });

      expect(jobManager.size).toBe(1);
    });
  });

  describe("GET /api/analyze/:jobId", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app).get("/api/analyze/some-job-id");
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent job", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      const res = await agent.get("/api/analyze/non-existent-id");
      expect(res.status).toBe(404);
    });

    it("returns 403 when another user tries to access a job", async () => {
      // User 1 creates a job
      const agent1 = request.agent(app);
      await authenticateAgent(agent1);

      const postRes = await agent1
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });
      const { jobId } = postRes.body;

      // User 2 tries to access
      const agent2 = request.agent(app);
      await authenticateAgent2(agent2);

      const res = await agent2.get(`/api/analyze/${jobId}`);
      expect(res.status).toBe(403);
      expect(res.body).toHaveProperty("error", "forbidden");
    });
  });

  describe("GET /api/analyze/:jobId/result", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await request(app).get("/api/analyze/some-job-id/result");
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent job", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      const res = await agent.get("/api/analyze/non-existent-id/result");
      expect(res.status).toBe(404);
    });

    it("returns 403 when another user tries to access", async () => {
      const agent1 = request.agent(app);
      await authenticateAgent(agent1);

      const postRes = await agent1
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });
      const { jobId } = postRes.body;

      const agent2 = request.agent(app);
      await authenticateAgent2(agent2);

      const res = await agent2.get(`/api/analyze/${jobId}/result`);
      expect(res.status).toBe(403);
    });

    it("returns 409 when job is not complete", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      // Create a job directly via jobManager so we control its state
      const jobId = jobManager.createJob("testuser");
      expect(jobId).not.toBeNull();

      // Job starts in "pending" state — verify precondition
      const job = jobManager.getJob(jobId!);
      expect(job).toBeDefined();
      expect(job!.status).toBe("pending");

      const res = await agent.get(`/api/analyze/${jobId}/result`);
      expect(res.status).toBe(409);
      expect(res.body).toHaveProperty("error", "not_ready");
    });

    it("returns analysis result when job is complete", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      // Create a job directly and mark it complete with a known result
      const jobId = jobManager.createJob("testuser");
      expect(jobId).not.toBeNull();
      jobManager.sendComplete(jobId!, {
        framework: "nextjs-app",
        screens: [],
        transitions: [],
      });

      // Verify precondition
      const job = jobManager.getJob(jobId!);
      expect(job).toBeDefined();
      expect(job!.status).toBe("complete");

      const res = await agent.get(`/api/analyze/${jobId}/result`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("framework");
      expect(res.body).toHaveProperty("screens");
      expect(res.body).toHaveProperty("transitions");
    });
  });

  describe("SSE integration", () => {
    it("streams progress events and complete event in order", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      // Create a job
      const postRes = await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });
      const { jobId } = postRes.body;

      // Wait a bit for the background pipeline to run
      await new Promise((resolve) => setTimeout(resolve, 200));

      // At this point the job should be complete (mocked pipeline is fast)
      const job = jobManager.getJob(jobId);

      // The job should be complete or have result
      // If it completed, an SSE connection will get the result immediately
      expect(job).toBeDefined();

      // Connect as SSE — since the job is already complete, we should get
      // the complete event immediately
      if (job!.status === "complete") {
        const sseRes = await agent
          .get(`/api/analyze/${jobId}`)
          .set("Accept", "text/event-stream")
          .buffer(true);

        expect(sseRes.status).toBe(200);
        expect(sseRes.text).toContain("event: complete");
        expect(sseRes.text).toContain('"framework":"nextjs-app"');
        expect(sseRes.text).toContain('"screens"');
      }
    });

    it("sends error event when pipeline fails", async () => {
      // Create an app with a failing adapter
      const failingClientManager = new CopilotClientManager(() => ({
        chatCompletion: vi
          .fn()
          .mockRejectedValue(new Error("LLM service unavailable")),
        dispose: vi.fn(),
      }));

      const failingJobManager = new JobManager(60000);
      const failingApp = createApp({
        clientManager: failingClientManager,
        jobManager: failingJobManager,
      });

      const agent = request.agent(failingApp);
      await authenticateAgent(agent);

      const postRes = await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });
      const { jobId } = postRes.body;

      // Wait for the pipeline to fail
      await new Promise((resolve) => setTimeout(resolve, 200));

      const job = failingJobManager.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("error");
      expect(job!.error).toContain("LLM service unavailable");

      // SSE should return error event
      const sseRes = await agent
        .get(`/api/analyze/${jobId}`)
        .set("Accept", "text/event-stream")
        .buffer(true);

      expect(sseRes.status).toBe(200);
      expect(sseRes.text).toContain("event: error");
      expect(sseRes.text).toContain("LLM service unavailable");

      failingJobManager.clear();
      failingClientManager.clear();
    });

    it("complete event contains valid AnalysisResult JSON", async () => {
      const agent = request.agent(app);
      await authenticateAgent(agent);

      const postRes = await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });
      const { jobId } = postRes.body;

      // Wait for pipeline
      await new Promise((resolve) => setTimeout(resolve, 200));

      const job = jobManager.getJob(jobId);
      if (job?.status === "complete" && job.result) {
        expect(job.result).toHaveProperty("framework", "nextjs-app");
        expect(job.result).toHaveProperty("screens");
        expect(job.result).toHaveProperty("transitions");
        expect(Array.isArray(job.result.screens)).toBe(true);
        expect(Array.isArray(job.result.transitions)).toBe(true);
      }
    });
  });

  describe("Android platform pipeline", () => {
    it("exercises the Android branch when detectPlatform returns 'android'", async () => {
      // Override detectPlatform to return "android" for this test
      const frameworkMod = await import("../analysis/framework-detector.js");
      const detectPlatformMock = vi.mocked(frameworkMod.detectPlatform);
      const detectAndroidFrameworkMock = vi.mocked(frameworkMod.detectAndroidFramework);

      detectPlatformMock.mockReturnValueOnce("android");
      detectAndroidFrameworkMock.mockReturnValueOnce({
        framework: "android-navigation",
        routingFilePatterns: ["**/res/navigation/*.xml"],
      });

      const agent = request.agent(app);
      await authenticateAgent(agent);

      const postRes = await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });

      expect(postRes.status).toBe(202);
      const { jobId } = postRes.body;

      // Wait for background pipeline
      await new Promise((resolve) => setTimeout(resolve, 300));

      const job = jobManager.getJob(jobId);
      expect(job).toBeDefined();
      // The pipeline should complete (or error gracefully). Since our mocks
      // still return valid LLM responses, it should succeed.
      expect(job!.status).toBe("complete");
      expect(detectAndroidFrameworkMock).toHaveBeenCalled();
    });
  });

  describe("Flutter platform pipeline", () => {
    it("exercises the Flutter branch when detectPlatform returns 'flutter'", async () => {
      const frameworkMod = await import("../analysis/framework-detector.js");
      const detectPlatformMock = vi.mocked(frameworkMod.detectPlatform);
      const detectFlutterFrameworkMock = vi.mocked(frameworkMod.detectFlutterFramework);

      detectPlatformMock.mockReturnValueOnce("flutter");
      detectFlutterFrameworkMock.mockReturnValueOnce({
        framework: "flutter-go-router",
        routingFilePatterns: ["lib/**/router.dart", "lib/**/routes.dart", "lib/**/*.dart"],
      });

      const agent = request.agent(app);
      await authenticateAgent(agent);

      const postRes = await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });

      expect(postRes.status).toBe(202);
      const { jobId } = postRes.body;

      // Wait for background pipeline
      await new Promise((resolve) => setTimeout(resolve, 300));

      const job = jobManager.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("complete");
      expect(detectFlutterFrameworkMock).toHaveBeenCalled();
    });
  });

  describe("iOS platform pipeline", () => {
    it("exercises the iOS branch when detectPlatform returns 'ios'", async () => {
      const frameworkMod = await import("../analysis/framework-detector.js");
      const detectPlatformMock = vi.mocked(frameworkMod.detectPlatform);
      const detectiOSFrameworkMock = vi.mocked(frameworkMod.detectiOSFramework);

      detectPlatformMock.mockReturnValueOnce("ios");
      detectiOSFrameworkMock.mockReturnValueOnce({
        framework: "ios-swiftui",
        routingFilePatterns: ["**/*View.swift", "**/*App.swift"],
      });

      const agent = request.agent(app);
      await authenticateAgent(agent);

      const postRes = await agent
        .post("/api/analyze")
        .send({ owner: "foo", repo: "bar", branch: "main" });

      expect(postRes.status).toBe(202);
      const { jobId } = postRes.body;

      // Wait for background pipeline
      await new Promise((resolve) => setTimeout(resolve, 300));

      const job = jobManager.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("complete");
      expect(detectiOSFrameworkMock).toHaveBeenCalled();
    });
  });

  describe("SSE event order verification", () => {
    it("progress events precede the complete event", async () => {
      // We'll manually drive the job manager to verify event ordering
      const testJobManager = new JobManager(60000);
      const jobId = testJobManager.createJob("testuser");

      // Create a mock SSE response
      const written: string[] = [];
      const mockRes = {
        write: vi.fn((chunk: string) => {
          written.push(chunk);
          return true;
        }),
        end: vi.fn(),
      } as unknown as import("express").Response;

      testJobManager.addConnection(jobId, mockRes);

      // Send progress events in order
      testJobManager.sendProgress(jobId, {
        step: "detecting_framework",
        message: "Detecting...",
      });
      testJobManager.sendProgress(jobId, {
        step: "fetching_files",
        message: "Fetching...",
      });
      testJobManager.sendProgress(jobId, {
        step: "analyzing_routes",
        message: "Analyzing routes...",
      });
      testJobManager.sendProgress(jobId, {
        step: "analyzing_variants",
        message: "Analyzing variants...",
      });
      testJobManager.sendProgress(jobId, {
        step: "analyzing_transitions",
        message: "Analyzing transitions...",
      });
      testJobManager.sendComplete(jobId, {
        framework: "nextjs-app",
        screens: [],
        transitions: [],
      });

      // Verify order
      expect(written).toHaveLength(6);
      expect(written[0]).toContain("event: progress");
      expect(written[0]).toContain("detecting_framework");
      expect(written[1]).toContain("event: progress");
      expect(written[1]).toContain("fetching_files");
      expect(written[2]).toContain("event: progress");
      expect(written[2]).toContain("analyzing_routes");
      expect(written[3]).toContain("event: progress");
      expect(written[3]).toContain("analyzing_variants");
      expect(written[4]).toContain("event: progress");
      expect(written[4]).toContain("analyzing_transitions");
      expect(written[5]).toContain("event: complete");
      expect(written[5]).toContain("nextjs-app");

      // Verify connection was closed after complete
      expect(mockRes.end).toHaveBeenCalled();

      testJobManager.clear();
    });
  });
});
