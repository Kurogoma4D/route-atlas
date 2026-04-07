import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../server.js";
import { resetInMemoryKV } from "../auth/session.js";
import type { Hono } from "hono";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

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

/** Helper: authenticate via OAuth flow and return the cookie jar */
async function authenticateAgent(app: Hono): Promise<Record<string, string>> {
  const jar: Record<string, string> = {};

  // Initiate OAuth to get state
  const ghRes = await requestWithCookies(app, "/api/auth/github", jar);
  const location = ghRes.headers.get("location")!;
  const state = new URL(location).searchParams.get("state")!;

  // Mock token exchange
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ access_token: "gho_test_repos_token" }),
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
  // Mock Copilot check
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

  await requestWithCookies(
    app,
    `/api/auth/callback?code=valid_code&state=${state}`,
    jar,
  );

  return jar;
}

const sampleRepos = [
  {
    id: 1,
    name: "repo-one",
    full_name: "testuser/repo-one",
    owner: { login: "testuser" },
    description: "First repo",
    private: false,
    default_branch: "main",
    language: "TypeScript",
    updated_at: "2025-01-01T00:00:00Z",
    html_url: "https://github.com/testuser/repo-one",
  },
  {
    id: 2,
    name: "repo-two",
    full_name: "testuser/repo-two",
    owner: { login: "testuser" },
    description: null,
    private: true,
    default_branch: "develop",
    language: "JavaScript",
    updated_at: "2025-01-02T00:00:00Z",
    html_url: "https://github.com/testuser/repo-two",
  },
];

const sampleBranches = [
  { name: "main", commit: { sha: "abc123" }, protected: true },
  { name: "develop", commit: { sha: "def456" }, protected: false },
  { name: "feature/test", commit: { sha: "ghi789" }, protected: false },
];

describe("Repos routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    app = createApp();
  });

  afterEach(() => {
    resetInMemoryKV();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("GET /api/repos", () => {
    it("should return 401 when not authenticated", async () => {
      const res = await app.request("/api/repos");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty("error", "unauthorized");
    });

    it("should return repository list for authenticated user", async () => {
      const jar = await authenticateAgent(app);

      // Mock GitHub repos API
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleRepos,
        headers: new Headers(),
      });

      const res = await requestWithCookies(app, "/api/repos", jar);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("repos");
      expect(body.repos).toHaveLength(2);
      expect(body.repos[0]).toMatchObject({
        id: 1,
        name: "repo-one",
        fullName: "testuser/repo-one",
        owner: "testuser",
        description: "First repo",
        private: false,
        defaultBranch: "main",
        language: "TypeScript",
      });
      expect(body.repos[1]).toMatchObject({
        id: 2,
        name: "repo-two",
        private: true,
      });
      expect(body).toHaveProperty("page", 1);
      expect(body).toHaveProperty("perPage", 30);
      expect(body).toHaveProperty("hasNextPage", false);
    });

    it("should support pagination parameters", async () => {
      const jar = await authenticateAgent(app);

      // Mock with link header indicating next page
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleRepos,
        headers: new Headers({
          link: '<https://api.github.com/user/repos?page=3&per_page=10>; rel="next", <https://api.github.com/user/repos?page=5&per_page=10>; rel="last"',
        }),
      });

      const res = await requestWithCookies(
        app,
        "/api/repos?page=2&per_page=10",
        jar,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("page", 2);
      expect(body).toHaveProperty("perPage", 10);
      expect(body).toHaveProperty("hasNextPage", true);

      // Verify the GitHub API was called with correct params
      const fetchCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      const url = fetchCall[0] as string;
      expect(url).toContain("page=2");
      expect(url).toContain("per_page=10");
    });

    it("should cap per_page at 100", async () => {
      const jar = await authenticateAgent(app);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => [],
        headers: new Headers(),
      });

      const res = await requestWithCookies(app, "/api/repos?per_page=200", jar);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("perPage", 100);

      const fetchCall = mockFetch.mock.calls[mockFetch.mock.calls.length - 1];
      const url = fetchCall[0] as string;
      expect(url).toContain("per_page=100");
    });

    it("should handle GitHub API errors", async () => {
      const jar = await authenticateAgent(app);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => "Rate limit exceeded",
        headers: new Headers(),
      });

      const res = await requestWithCookies(app, "/api/repos", jar);

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body).toHaveProperty("error", "github_api_error");
    });
  });

  describe("GET /api/repos/:owner/:repo/branches", () => {
    it("should return 401 when not authenticated", async () => {
      const res = await app.request("/api/repos/testuser/repo-one/branches");
      expect(res.status).toBe(401);
    });

    it("should return branch list for a repository", async () => {
      const jar = await authenticateAgent(app);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => sampleBranches,
        headers: new Headers(),
      });

      const res = await requestWithCookies(
        app,
        "/api/repos/testuser/repo-one/branches",
        jar,
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("branches");
      expect(body.branches).toHaveLength(3);
      expect(body.branches[0]).toMatchObject({
        name: "main",
        commit: "abc123",
        protected: true,
      });
      expect(body.branches[1]).toMatchObject({
        name: "develop",
        commit: "def456",
        protected: false,
      });
    });

    it("should handle GitHub API errors for branches", async () => {
      const jar = await authenticateAgent(app);

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => "Not Found",
        headers: new Headers(),
      });

      const res = await requestWithCookies(
        app,
        "/api/repos/testuser/nonexistent/branches",
        jar,
      );

      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body).toHaveProperty("error", "github_api_error");
    });
  });
});
