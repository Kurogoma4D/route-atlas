import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createApp } from "../server.js";
import { CopilotClientManager } from "../analysis/copilot-client.js";
import { JobStore, getInMemoryJobKV } from "../analyze/job-store.js";
import { resetInMemoryKV } from "./session.js";
import type { Hono } from "hono";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ---------------------------------------------------------------------------
// Cookie-aware request helper
// ---------------------------------------------------------------------------

/** Extract Set-Cookie headers and merge them into a cookie jar (simple map). */
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
// Tests
// ---------------------------------------------------------------------------

describe("Auth routes", () => {
  let app: Hono;

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
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
    resetInMemoryKV();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("GET /api/auth/github", () => {
    it("should redirect to GitHub OAuth authorize URL with state and updated scope", async () => {
      const jar: Record<string, string> = {};
      const res = await requestWithCookies(app, "/api/auth/github", jar);

      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toContain("https://github.com/login/oauth/authorize");
      expect(location).toContain("client_id=test-client-id");
      expect(location).toContain("scope=repo+read%3Auser");
      expect(location).toMatch(/state=[a-f0-9]{32}/);
    });

    it("should return 500 if GITHUB_CLIENT_ID is not set", async () => {
      vi.stubEnv("GITHUB_CLIENT_ID", "");
      delete process.env["GITHUB_CLIENT_ID"];
      app = createApp();

      const res = await app.request("/api/auth/github");
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body).toHaveProperty("error", "config_error");
    });
  });

  describe("GET /api/auth/callback", () => {
    /** Helper: initiate OAuth flow via GET /github to obtain a session with state */
    async function initiateOAuthFlow(
      jar: Record<string, string>,
    ): Promise<string> {
      const res = await requestWithCookies(app, "/api/auth/github", jar);
      const location = res.headers.get("location")!;
      const url = new URL(location);
      return url.searchParams.get("state")!;
    }

    it("should redirect to /login?error=missing_code when no code", async () => {
      const jar: Record<string, string> = {};
      const res = await requestWithCookies(app, "/api/auth/callback", jar);

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=missing_code");
    });

    it("should redirect to /login?error=oauth_denied when error param present", async () => {
      const jar: Record<string, string> = {};
      const res = await requestWithCookies(
        app,
        "/api/auth/callback?error=access_denied",
        jar,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=oauth_denied");
    });

    it("should redirect to /login?error=state_mismatch when state is missing", async () => {
      const jar: Record<string, string> = {};
      const res = await requestWithCookies(
        app,
        "/api/auth/callback?code=test_code_123",
        jar,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=state_mismatch");
    });

    it("should redirect to /login?error=state_mismatch when state does not match", async () => {
      const jar: Record<string, string> = {};
      await initiateOAuthFlow(jar);

      const res = await requestWithCookies(
        app,
        "/api/auth/callback?code=test_code_123&state=wrong_state",
        jar,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?error=state_mismatch");
    });

    it("should exchange code for token and redirect to / on success", async () => {
      const jar: Record<string, string> = {};
      const state = await initiateOAuthFlow(jar);

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

      const res = await requestWithCookies(
        app,
        `/api/auth/callback?code=test_code_123&state=${state}`,
        jar,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/");

      // Verify token exchange was called correctly
      expect(mockFetch).toHaveBeenCalledWith(
        "https://github.com/login/oauth/access_token",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            client_id: "test-client-id",
            client_secret: "test-client-secret",
            code: "test_code_123",
            redirect_uri: "http://localhost:3000/api/auth/callback",
          }),
        }),
      );
    });

    it("should redirect to /login on token exchange failure", async () => {
      const jar: Record<string, string> = {};
      const state = await initiateOAuthFlow(jar);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect",
        }),
      });

      const res = await requestWithCookies(
        app,
        `/api/auth/callback?code=bad_code&state=${state}`,
        jar,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(
        /^\/login\?error=token_exchange_failed/,
      );
    });
  });

  describe("GET /api/auth/me", () => {
    it("should return 401 when not authenticated", async () => {
      const res = await app.request("/api/auth/me");
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty("error", "unauthorized");
    });

    it("should return user info when authenticated", async () => {
      const jar: Record<string, string> = {};

      // Initiate OAuth flow to get state
      const ghRes = await requestWithCookies(app, "/api/auth/github", jar);
      const location = ghRes.headers.get("location")!;
      const state = new URL(location).searchParams.get("state")!;

      // Mock token exchange, user info, and Copilot check
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "gho_test_token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          login: "testuser",
          avatar_url: "https://github.com/testuser.png",
          name: "Test User",
        }),
      });
      mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });

      await requestWithCookies(
        app,
        `/api/auth/callback?code=valid_code&state=${state}`,
        jar,
      );

      const res = await requestWithCookies(app, "/api/auth/me", jar);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("login", "testuser");
      expect(body).toHaveProperty(
        "avatarUrl",
        "https://github.com/testuser.png",
      );
      expect(body).toHaveProperty("name", "Test User");
      expect(body).toHaveProperty("hasCopilot", true);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("should destroy session and return success", async () => {
      const jar: Record<string, string> = {};

      // Initiate OAuth flow to get state
      const ghRes = await requestWithCookies(app, "/api/auth/github", jar);
      const location = ghRes.headers.get("location")!;
      const state = new URL(location).searchParams.get("state")!;

      // Authenticate first
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "gho_test_token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          login: "testuser",
          avatar_url: "https://github.com/testuser.png",
          name: null,
        }),
      });
      mockFetch.mockResolvedValueOnce({ ok: false });

      await requestWithCookies(
        app,
        `/api/auth/callback?code=valid_code&state=${state}`,
        jar,
      );

      // Verify authenticated
      let res = await requestWithCookies(app, "/api/auth/me", jar);
      expect(res.status).toBe(200);

      // Logout
      res = await requestWithCookies(app, "/api/auth/logout", jar, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty("message", "Logged out");

      // Verify no longer authenticated
      res = await requestWithCookies(app, "/api/auth/me", jar);
      expect(res.status).toBe(401);
    });
  });

  describe("requireAuth middleware", () => {
    it("should block unauthenticated access to protected routes", async () => {
      const res = await app.request("/api/analyze", { method: "POST" });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty("error", "unauthorized");
    });
  });
});
