/**
 * KV-based session middleware for Hono on Cloudflare Workers.
 *
 * Session data is stored in a Workers KV namespace (`SESSIONS`).
 * A random session ID is stored in an HTTP-only cookie.
 * On each request the middleware reads the session from KV, and after the
 * handler runs it writes the (possibly updated) session back with a 24-hour TTL.
 */

import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { UserInfo } from "@route-atlas/shared";

// ---------------------------------------------------------------------------
// Session shape
// ---------------------------------------------------------------------------

export interface SessionData {
  encryptedToken?: string;
  user?: UserInfo;
  hasCopilot?: boolean;
  oauthState?: string;
}

// ---------------------------------------------------------------------------
// Hono env & context variable declarations
// ---------------------------------------------------------------------------

/**
 * Cloudflare Workers bindings that the app expects.
 * `SESSIONS` is a KV namespace bound in wrangler.toml.
 */
export interface AppBindings {
  Bindings: {
    SESSIONS: KVNamespace;
    // Environment variables set in wrangler.toml [vars] or secrets
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    SESSION_SECRET?: string;
    OAUTH_CALLBACK_URL?: string;
    FRONTEND_ORIGIN?: string;
    ALLOWED_ORIGINS?: string;
    COOKIE_SECURE?: string;
    NODE_ENV?: string;
  };
  Variables: {
    session: SessionData;
    sessionId: string;
  };
}

declare module "hono" {
  interface ContextVariableMap {
    session: SessionData;
    sessionId: string;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSION_COOKIE_NAME = "ra_sid";
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const SESSION_ID_PATTERN = /^[0-9a-f]{48}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateSessionId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // Convert to hex string (48 hex characters from 24 random bytes)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Minimal KV interface so the middleware can be tested without real Workers KV.
 * Compatible with Cloudflare Workers KVNamespace.
 */
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function sessionMiddleware() {
  return createMiddleware(async (c, next) => {
    // Obtain the KV namespace from the Cloudflare bindings.
    // In local dev (non-Workers) we fall back to an in-memory store.
    const kv: KVLike = (c.env as Record<string, unknown>)?.["SESSIONS"]
      ? ((c.env as Record<string, unknown>)["SESSIONS"] as KVLike)
      : getInMemoryKV();

    // Read session ID from cookie and validate its format
    let sessionId = getCookie(c, SESSION_COOKIE_NAME) ?? "";
    if (sessionId && !SESSION_ID_PATTERN.test(sessionId)) {
      sessionId = "";
    }
    let session: SessionData = {};

    if (sessionId) {
      const raw = await kv.get(`session:${sessionId}`);
      if (raw) {
        try {
          session = JSON.parse(raw) as SessionData;
        } catch {
          session = {};
        }
      } else {
        // Cookie references a non-existent/expired KV entry – issue new ID
        sessionId = "";
      }
    }

    if (!sessionId) {
      sessionId = generateSessionId();
    }

    c.set("session", session);
    c.set("sessionId", sessionId);

    await next();

    // Persist session back to KV after the handler runs
    const updated = c.get("session") as SessionData;

    // Default to secure cookies unless explicitly opted out via env var.
    const secure =
      (c.env as Record<string, string | undefined>)?.["COOKIE_SECURE"] !==
      "false";

    if (updated && Object.keys(updated).length > 0) {
      await kv.put(`session:${sessionId}`, JSON.stringify(updated), {
        expirationTtl: SESSION_TTL_SECONDS,
      });

      setCookie(c, SESSION_COOKIE_NAME, sessionId, {
        path: "/",
        httpOnly: true,
        secure,
        sameSite: "Lax",
        maxAge: SESSION_TTL_SECONDS,
      });
    } else {
      // Session was cleared – remove KV entry and cookie
      await kv.delete(`session:${sessionId}`);
      deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    }
  });
}

/**
 * Destroy the session by clearing the context variable and deleting the cookie.
 * The middleware's post-handler logic will detect the empty session and delete
 * the KV entry automatically.
 */
export function destroySession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any, any, any>,
): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  c.set("session", {});
}

// ---------------------------------------------------------------------------
// In-memory KV fallback for local development / tests
// ---------------------------------------------------------------------------

let _inMemoryStore: Map<string, { value: string; expiresAt: number }> | null =
  null;

function getInMemoryKV(): KVLike {
  if (!_inMemoryStore) {
    _inMemoryStore = new Map();
  }
  const store = _inMemoryStore;

  return {
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(
      key: string,
      value: string,
      options?: { expirationTtl?: number },
    ) {
      const ttl = options?.expirationTtl ?? SESSION_TTL_SECONDS;
      store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

/**
 * Reset the in-memory KV store. Useful for tests.
 */
export function resetInMemoryKV(): void {
  _inMemoryStore = null;
}
