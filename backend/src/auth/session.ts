/**
 * In-memory session middleware for Hono on Node.js (Cloud Run).
 *
 * Session data is stored in an in-memory Map with TTL-based expiration.
 * A random session ID is stored in an HTTP-only cookie.
 * On each request the middleware reads the session from the store, and after
 * the handler runs it writes the (possibly updated) session back with a
 * 24-hour TTL.
 *
 * Note: This in-memory store is suitable for a single Cloud Run instance.
 * For multi-instance scaling, replace with Redis (Cloud Memorystore) or
 * Firestore.
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
// Hono context variable declarations
// ---------------------------------------------------------------------------

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
 * Minimal KV-like interface for session and job storage.
 * Compatible with both in-memory implementation and external stores.
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
    const kv: KVLike = getInMemoryKV();

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
        // Cookie references a non-existent/expired entry — issue new ID
        sessionId = "";
      }
    }

    if (!sessionId) {
      sessionId = generateSessionId();
    }

    c.set("session", session);
    c.set("sessionId", sessionId);

    await next();

    // Persist session back to store after the handler runs
    const updated = c.get("session") as SessionData;

    // Default to secure cookies unless explicitly opted out via env var.
    const secure = process.env["COOKIE_SECURE"] !== "false";

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
      // Session was cleared — remove entry and cookie
      await kv.delete(`session:${sessionId}`);
      deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
    }
  });
}

/**
 * Destroy the session by clearing the context variable and deleting the cookie.
 * The middleware's post-handler logic will detect the empty session and delete
 * the store entry automatically.
 */
export function destroySession(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any, any, any>,
): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  c.set("session", {});
}

// ---------------------------------------------------------------------------
// In-memory KV store
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
