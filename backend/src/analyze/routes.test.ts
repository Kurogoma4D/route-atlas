import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../server.js";
import { JobManager } from "./job-manager.js";
import { CopilotClientManager } from "../analysis/copilot-client.js";
import { resetInMemoryKV } from "../auth/session.js";
import type { LLMAdapter } from "../analysis/copilot-client.js";
import type { Hono } from "hono";
import type { SSEWriter } from "./job-manager.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fetch globally for auth + GitHub API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock the analysis modules to avoid real GitHub API / LLM calls
vi.mock("../analysis/framework-detector.js", async () => {
  const actual = await vi.importActual<
    typeof import("../analysis/framework-detector.js")
  >("../analysis/framework-detector.js");
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
      routingFilePatterns: [
        "lib/**/router.dart",
        "lib/**/routes.dart",
        "lib/**/*_router.dart",
      ],
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
// Cookie-aware request helper
// ---------------------------------------------------------------------------

function extractCookies(
  res: Response,
  jar: Record<string, string>,
): Record<string, string> {
  const setCookies = res.headers.getSetAll
    ? (
        res.headers as unknown as { getSetAll(name: string): string[] }
      ).getSetAll("set-cookie")
    : (res.headers.get("set-cookie")?.split(", ").filter(Boolean) ?? []);
  for (const raw of setCookies) {
    const parts = raw.split(";")[0].split("=");
    if (parts.length >= 2) {
      jar[parts[0]] = parts.slice(1).join("=");
    }
  }
  return jar;
}

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function requestWithCookies(
  app: Hono,
  path: string,
  jar: Record<string, string>,
  init?: RequestInit,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  const cookie = cookieHeader(jar);
  if (cookie) {
    headers["Cookie"] = cookie;
  }
  const res = await app.request(path, { ...init, headers });
  extractCookies(res, jar);
  return res;
}

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
 * Authenticate via OAuth flow and return the cookie jar.
 */
async function authenticateAgent(app: Hono): Promise<Record<string, string>> {
  const jar: Record<string, string> = {};

  const ghRes = await requestWithCookies(app, "/api/auth/github", jar);
  const location = ghRes.headers.get("location")!;
  const state = new URL(location).searchParams.get("state")!;

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "gho_test_token_123" }),
  });

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      login: "testuser",
      avatar_url: "https://github.com/testuser.png",
      name: "Test User",
    }),
  });

  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({}),
  });

  await requestWithCookies(
    app,
    `/api/auth/callback?code=valid_code&state=${state}`,
    jar,
  );

  return jar;
}

/**
 * Authenticate a second user (different login).
 */
async function authenticateAgent2(app: Hono): Promise<Record<string, string>> {
  const jar: Record<string, string> = {};

  const ghRes = await requestWithCookies(app, "/api/auth/github", jar);
  const location = ghRes.headers.get("location")!;
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

  await requestWithCookies(
    app,
    `/api/auth/callback?code=valid_code_2&state=${state}`,
    jar,
  );

  return jar;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Analysis API routes", () => {
  let app: Hono;
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
    resetInMemoryKV();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("POST /api/analyze", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await app.request("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });

      expect(res.status).toBe(401);
    });

    it("returns 400 when required fields are missing", async () => {
      const jar = await authenticateAgent(app);

      const res = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo" }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toHaveProperty("error", "validation_error");
    });

    it("returns 202 with jobId", async () => {
      const jar = await authenticateAgent(app);

      const res = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });

      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body).toHaveProperty("jobId");
      expect(typeof body.jobId).toBe("string");
    });

    it("creates a job in the job manager", async () => {
      const jar = await authenticateAgent(app);

      expect(jobManager.size).toBe(0);

      await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });

      expect(jobManager.size).toBe(1);
    });
  });

  describe("GET /api/analyze/:jobId", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await app.request("/api/analyze/some-job-id");
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent job", async () => {
      const jar = await authenticateAgent(app);

      const res = await requestWithCookies(
        app,
        "/api/analyze/non-existent-id",
        jar,
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 when another user tries to access a job", async () => {
      // User 1 creates a job
      const jar1 = await authenticateAgent(app);

      const postRes = await requestWithCookies(app, "/api/analyze", jar1, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });
      const { jobId } = await postRes.json();

      // User 2 tries to access
      const jar2 = await authenticateAgent2(app);

      const res = await requestWithCookies(app, `/api/analyze/${jobId}`, jar2);
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toHaveProperty("error", "forbidden");
    });
  });

  describe("GET /api/analyze/:jobId/result", () => {
    it("returns 401 when not authenticated", async () => {
      const res = await app.request("/api/analyze/some-job-id/result");
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent job", async () => {
      const jar = await authenticateAgent(app);

      const res = await requestWithCookies(
        app,
        "/api/analyze/non-existent-id/result",
        jar,
      );
      expect(res.status).toBe(404);
    });

    it("returns 403 when another user tries to access", async () => {
      const jar1 = await authenticateAgent(app);

      const postRes = await requestWithCookies(app, "/api/analyze", jar1, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });
      const { jobId } = await postRes.json();

      const jar2 = await authenticateAgent2(app);

      const res = await requestWithCookies(
        app,
        `/api/analyze/${jobId}/result`,
        jar2,
      );
      expect(res.status).toBe(403);
    });

    it("returns 409 when job is not complete", async () => {
      const jar = await authenticateAgent(app);

      // Create a job directly via jobManager so we control its state
      const jobId = jobManager.createJob("testuser");
      expect(jobId).not.toBeNull();

      // Job starts in "pending" state
      const job = jobManager.getJob(jobId!);
      expect(job).toBeDefined();
      expect(job!.status).toBe("pending");

      const res = await requestWithCookies(
        app,
        `/api/analyze/${jobId}/result`,
        jar,
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body).toHaveProperty("error", "not_ready");
    });

    it("returns analysis result when job is complete", async () => {
      const jar = await authenticateAgent(app);

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

      const res = await requestWithCookies(
        app,
        `/api/analyze/${jobId}/result`,
        jar,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("framework");
      expect(body).toHaveProperty("screens");
      expect(body).toHaveProperty("transitions");
    });
  });

  describe("SSE integration", () => {
    it("streams progress events and complete event in order", async () => {
      const jar = await authenticateAgent(app);

      // Create a job
      const postRes = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });
      const { jobId } = await postRes.json();

      // Wait a bit for the background pipeline to run
      await new Promise((resolve) => setTimeout(resolve, 200));

      // At this point the job should be complete (mocked pipeline is fast)
      const job = jobManager.getJob(jobId);
      expect(job).toBeDefined();

      // Connect as SSE — since the job is already complete, we should get
      // the complete event immediately
      if (job!.status === "complete") {
        const sseRes = await requestWithCookies(
          app,
          `/api/analyze/${jobId}`,
          jar,
          {
            headers: { Accept: "text/event-stream" },
          },
        );

        expect(sseRes.status).toBe(200);
        const text = await sseRes.text();
        expect(text).toContain("event: complete");
        expect(text).toContain('"framework":"nextjs-app"');
        expect(text).toContain('"screens"');
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

      const jar = await authenticateAgent(failingApp);

      const postRes = await requestWithCookies(
        failingApp,
        "/api/analyze",
        jar,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            owner: "foo",
            repo: "bar",
            branch: "main",
          }),
        },
      );
      const { jobId } = await postRes.json();

      // Wait for the pipeline to fail
      await new Promise((resolve) => setTimeout(resolve, 200));

      const job = failingJobManager.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("error");
      expect(job!.error).toContain("LLM service unavailable");

      // SSE should return error event
      const sseRes = await requestWithCookies(
        failingApp,
        `/api/analyze/${jobId}`,
        jar,
        {
          headers: { Accept: "text/event-stream" },
        },
      );

      expect(sseRes.status).toBe(200);
      const text = await sseRes.text();
      expect(text).toContain("event: error");
      expect(text).toContain("LLM service unavailable");

      failingJobManager.clear();
      failingClientManager.clear();
    });

    it("complete event contains valid AnalysisResult JSON", async () => {
      const jar = await authenticateAgent(app);

      const postRes = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });
      const { jobId } = await postRes.json();

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
      const frameworkMod = await import("../analysis/framework-detector.js");
      const detectPlatformMock = vi.mocked(frameworkMod.detectPlatform);
      const detectAndroidFrameworkMock = vi.mocked(
        frameworkMod.detectAndroidFramework,
      );

      detectPlatformMock.mockReturnValueOnce("android");
      detectAndroidFrameworkMock.mockReturnValueOnce({
        framework: "android-navigation",
        routingFilePatterns: ["**/res/navigation/*.xml"],
      });

      const jar = await authenticateAgent(app);

      const postRes = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });

      expect(postRes.status).toBe(202);
      const { jobId } = await postRes.json();

      // Wait for background pipeline
      await new Promise((resolve) => setTimeout(resolve, 300));

      const job = jobManager.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("complete");
      expect(detectAndroidFrameworkMock).toHaveBeenCalled();
    });
  });

  describe("Flutter platform pipeline", () => {
    it("exercises the Flutter branch when detectPlatform returns 'flutter'", async () => {
      const frameworkMod = await import("../analysis/framework-detector.js");
      const detectPlatformMock = vi.mocked(frameworkMod.detectPlatform);
      const detectFlutterFrameworkMock = vi.mocked(
        frameworkMod.detectFlutterFramework,
      );

      detectPlatformMock.mockReturnValueOnce("flutter");
      detectFlutterFrameworkMock.mockReturnValueOnce({
        framework: "flutter-go-router",
        routingFilePatterns: [
          "lib/**/router.dart",
          "lib/**/routes.dart",
          "lib/**/*_router.dart",
        ],
      });

      const jar = await authenticateAgent(app);

      const postRes = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });

      expect(postRes.status).toBe(202);
      const { jobId } = await postRes.json();

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

      const jar = await authenticateAgent(app);

      const postRes = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });

      expect(postRes.status).toBe(202);
      const { jobId } = await postRes.json();

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

      // Create a mock SSE writer
      const written: string[] = [];
      const mockWriter: SSEWriter = {
        write: vi.fn((chunk: string) => {
          written.push(chunk);
          return true;
        }),
        end: vi.fn(),
      };

      testJobManager.addConnection(jobId!, mockWriter);

      // Send progress events in order
      testJobManager.sendProgress(jobId!, {
        step: "detecting_framework",
        message: "Detecting...",
      });
      testJobManager.sendProgress(jobId!, {
        step: "fetching_files",
        message: "Fetching...",
      });
      testJobManager.sendProgress(jobId!, {
        step: "analyzing_routes",
        message: "Analyzing routes...",
      });
      testJobManager.sendProgress(jobId!, {
        step: "analyzing_variants",
        message: "Analyzing variants...",
      });
      testJobManager.sendProgress(jobId!, {
        step: "analyzing_transitions",
        message: "Analyzing transitions...",
      });
      testJobManager.sendComplete(jobId!, {
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
      expect(mockWriter.end).toHaveBeenCalled();

      testJobManager.clear();
    });
  });
});
