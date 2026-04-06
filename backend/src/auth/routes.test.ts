import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createApp } from "../server.js";
import type { Express } from "express";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("Auth routes", () => {
  let app: Express;

  beforeEach(() => {
    vi.stubEnv("GITHUB_CLIENT_ID", "test-client-id");
    vi.stubEnv("GITHUB_CLIENT_SECRET", "test-client-secret");
    vi.stubEnv("SESSION_SECRET", "test-session-secret");
    app = createApp();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("GET /api/auth/github", () => {
    it("should redirect to GitHub OAuth authorize URL", async () => {
      const res = await request(app).get("/api/auth/github");

      expect(res.status).toBe(302);
      expect(res.headers["location"]).toContain(
        "https://github.com/login/oauth/authorize",
      );
      expect(res.headers["location"]).toContain("client_id=test-client-id");
      expect(res.headers["location"]).toContain("scope=repo");
    });

    it("should return 500 if GITHUB_CLIENT_ID is not set", async () => {
      vi.stubEnv("GITHUB_CLIENT_ID", "");
      delete process.env["GITHUB_CLIENT_ID"];
      app = createApp();

      const res = await request(app).get("/api/auth/github");
      expect(res.status).toBe(500);
      expect(res.body).toHaveProperty("error", "config_error");
    });
  });

  describe("GET /api/auth/callback", () => {
    it("should redirect to /login?error=missing_code when no code", async () => {
      const res = await request(app).get("/api/auth/callback");

      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe("/login?error=missing_code");
    });

    it("should redirect to /login?error=oauth_denied when error param present", async () => {
      const res = await request(app).get(
        "/api/auth/callback?error=access_denied",
      );

      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe("/login?error=oauth_denied");
    });

    it("should exchange code for token and redirect to / on success", async () => {
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

      const res = await request(app).get(
        "/api/auth/callback?code=test_code_123",
      );

      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe("/");

      // Verify token exchange was called correctly
      expect(mockFetch).toHaveBeenCalledWith(
        "https://github.com/login/oauth/access_token",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            client_id: "test-client-id",
            client_secret: "test-client-secret",
            code: "test_code_123",
          }),
        }),
      );
    });

    it("should redirect to /login on token exchange failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect",
        }),
      });

      const res = await request(app).get("/api/auth/callback?code=bad_code");

      expect(res.status).toBe(302);
      expect(res.headers["location"]).toBe(
        "/login?error=token_exchange_failed",
      );
    });
  });

  describe("GET /api/auth/me", () => {
    it("should return 401 when not authenticated", async () => {
      const res = await request(app).get("/api/auth/me");

      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "unauthorized");
    });

    it("should return user info when authenticated", async () => {
      // First, authenticate via callback
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

      const agent = request.agent(app);
      await agent.get("/api/auth/callback?code=valid_code");

      const res = await agent.get("/api/auth/me");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("login", "testuser");
      expect(res.body).toHaveProperty(
        "avatarUrl",
        "https://github.com/testuser.png",
      );
      expect(res.body).toHaveProperty("name", "Test User");
      expect(res.body).toHaveProperty("hasCopilot", true);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("should destroy session and return success", async () => {
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

      const agent = request.agent(app);
      await agent.get("/api/auth/callback?code=valid_code");

      // Verify authenticated
      let res = await agent.get("/api/auth/me");
      expect(res.status).toBe(200);

      // Logout
      res = await agent.post("/api/auth/logout");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("message", "Logged out");

      // Verify no longer authenticated
      res = await agent.get("/api/auth/me");
      expect(res.status).toBe(401);
    });
  });

  describe("requireAuth middleware", () => {
    it("should block unauthenticated access to protected routes", async () => {
      const res = await request(app).post("/api/analyze");
      expect(res.status).toBe(401);
      expect(res.body).toHaveProperty("error", "unauthorized");
    });
  });
});
