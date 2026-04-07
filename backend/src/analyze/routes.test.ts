import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../server.js";
import { JobStore, getInMemoryJobKV, resetInMemoryJobKV } from "./job-store.js";
import { CopilotClientManager } from "../analysis/copilot-client.js";
import { resetInMemoryKV } from "../auth/session.js";
import type { LLMAdapter } from "../analysis/copilot-client.js";
import type { KVLike } from "../auth/session.js";
import type { Hono } from "hono";

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
  let jobStore: JobStore;
  let jobsKV: KVLike;
  let clientManager: CopilotClientManager;

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    mockFetch.mockReset();

    resetInMemoryJobKV();
    jobsKV = getInMemoryJobKV();
    jobStore = new JobStore(jobsKV);
    clientManager = new CopilotClientManager(() => createMockAdapter());
    app = createApp({ clientManager, jobStore, jobsKV });
  });

  afterEach(() => {
    clientManager.clear();
    resetInMemoryKV();
    resetInMemoryJobKV();
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

    it("creates a job in the job store", async () => {
      const jar = await authenticateAgent(app);

      const res = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });

      const { jobId } = await res.json();
      const job = await jobStore.getJob(jobId);
      expect(job).toBeDefined();
      expect(job).not.toBeNull();
    });
  });

  describe("GET /api/analyze/:jobId (polling)", () => {
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

    it("returns job status JSON for pending job", async () => {
      const jar = await authenticateAgent(app);

      // Create a job directly via store
      const jobId = await jobStore.createJob("testuser");
      expect(jobId).not.toBeNull();

      const res = await requestWithCookies(app, `/api/analyze/${jobId}`, jar);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("status", "pending");
      expect(body).toHaveProperty("step");
      expect(body).toHaveProperty("message");
    });

    it("returns running status with step info", async () => {
      const jar = await authenticateAgent(app);

      const jobId = await jobStore.createJob("testuser");
      await jobStore.sendProgress(jobId!, {
        step: "detecting_framework",
        message: "Detecting...",
      });

      const res = await requestWithCookies(app, `/api/analyze/${jobId}`, jar);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("status", "running");
      expect(body).toHaveProperty("step", "detecting_framework");
      expect(body).toHaveProperty("message", "Detecting...");
    });

    it("returns complete status", async () => {
      const jar = await authenticateAgent(app);

      const jobId = await jobStore.createJob("testuser");
      await jobStore.sendComplete(jobId!, {
        framework: "nextjs-app",
        screens: [],
        transitions: [],
      });

      const res = await requestWithCookies(app, `/api/analyze/${jobId}`, jar);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("status", "complete");
    });

    it("returns error status with error message", async () => {
      const jar = await authenticateAgent(app);

      const jobId = await jobStore.createJob("testuser");
      await jobStore.sendError(jobId!, "Something failed");

      const res = await requestWithCookies(app, `/api/analyze/${jobId}`, jar);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("status", "error");
      expect(body).toHaveProperty("error", "Something failed");
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

      const jobId = await jobStore.createJob("testuser");
      expect(jobId).not.toBeNull();

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

      const jobId = await jobStore.createJob("testuser");
      expect(jobId).not.toBeNull();
      await jobStore.sendComplete(jobId!, {
        framework: "nextjs-app",
        screens: [],
        transitions: [],
      });

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

  describe("Pipeline integration", () => {
    it("pipeline completes and result is available via polling", async () => {
      const jar = await authenticateAgent(app);

      const postRes = await requestWithCookies(app, "/api/analyze", jar, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ owner: "foo", repo: "bar", branch: "main" }),
      });
      const { jobId } = await postRes.json();

      // Wait for the background pipeline to run
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Poll the job status
      const pollRes = await requestWithCookies(
        app,
        `/api/analyze/${jobId}`,
        jar,
      );
      expect(pollRes.status).toBe(200);
      const pollBody = await pollRes.json();
      expect(pollBody.status).toBe("complete");

      // Fetch the result
      const resultRes = await requestWithCookies(
        app,
        `/api/analyze/${jobId}/result`,
        jar,
      );
      expect(resultRes.status).toBe(200);
      const result = await resultRes.json();
      expect(result).toHaveProperty("framework", "nextjs-app");
      expect(result).toHaveProperty("screens");
      expect(result).toHaveProperty("transitions");
    });

    it("reports error when pipeline fails", async () => {
      // Create an app with a failing adapter
      const failingClientManager = new CopilotClientManager(() => ({
        chatCompletion: vi
          .fn()
          .mockRejectedValue(new Error("LLM service unavailable")),
        dispose: vi.fn(),
      }));

      resetInMemoryJobKV();
      const failingJobsKV = getInMemoryJobKV();
      const failingJobStore = new JobStore(failingJobsKV);
      const failingApp = createApp({
        clientManager: failingClientManager,
        jobStore: failingJobStore,
        jobsKV: failingJobsKV,
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
      await new Promise((resolve) => setTimeout(resolve, 300));

      const pollRes = await requestWithCookies(
        failingApp,
        `/api/analyze/${jobId}`,
        jar,
      );
      const pollBody = await pollRes.json();
      expect(pollBody.status).toBe("error");
      expect(pollBody.error).toContain("LLM service unavailable");

      failingClientManager.clear();
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

      const job = await jobStore.getJob(jobId);
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

      const job = await jobStore.getJob(jobId);
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

      const job = await jobStore.getJob(jobId);
      expect(job).toBeDefined();
      expect(job!.status).toBe("complete");
      expect(detectiOSFrameworkMock).toHaveBeenCalled();
    });
  });

  describe("Job state progression", () => {
    it("job state progresses from pending through running to complete", async () => {
      const jobId = await jobStore.createJob("testuser");
      expect(jobId).not.toBeNull();

      // Initial state
      let job = await jobStore.getJob(jobId!);
      expect(job!.status).toBe("pending");

      // Progress updates
      await jobStore.sendProgress(jobId!, {
        step: "detecting_framework",
        message: "Detecting...",
      });
      job = await jobStore.getJob(jobId!);
      expect(job!.status).toBe("running");
      expect(job!.step).toBe("detecting_framework");

      await jobStore.sendProgress(jobId!, {
        step: "fetching_files",
        message: "Fetching...",
      });
      job = await jobStore.getJob(jobId!);
      expect(job!.step).toBe("fetching_files");

      await jobStore.sendProgress(jobId!, {
        step: "analyzing_routes",
        message: "Analyzing routes...",
      });
      await jobStore.sendProgress(jobId!, {
        step: "analyzing_variants",
        message: "Analyzing variants...",
      });
      await jobStore.sendProgress(jobId!, {
        step: "analyzing_transitions",
        message: "Analyzing transitions...",
      });

      // Complete
      await jobStore.sendComplete(jobId!, {
        framework: "nextjs-app",
        screens: [],
        transitions: [],
      });

      job = await jobStore.getJob(jobId!);
      expect(job!.status).toBe("complete");
      expect(job!.result).toHaveProperty("framework", "nextjs-app");
    });
  });
});
