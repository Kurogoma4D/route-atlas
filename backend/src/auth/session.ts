/**
 * Cookie-based session middleware for Hono.
 *
 * Replaces express-session with encrypted cookie storage.
 * Session data is encrypted with AES-256-GCM before being stored in a cookie.
 */

import { createMiddleware } from "hono/factory";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { encrypt, decrypt } from "./crypto.js";
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
// Hono context variable key
// ---------------------------------------------------------------------------

declare module "hono" {
  interface ContextVariableMap {
    session: SessionData;
  }
}

const SESSION_COOKIE_NAME = "ra_session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function encodeSession(data: SessionData): string {
  const json = JSON.stringify(data);
  return encrypt(json);
}

function decodeSession(cookie: string): SessionData {
  try {
    const json = decrypt(cookie);
    return JSON.parse(json) as SessionData;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function sessionMiddleware() {
  return createMiddleware(async (c, next) => {
    // Read existing session from cookie
    const raw = getCookie(c, SESSION_COOKIE_NAME);
    const session: SessionData = raw ? decodeSession(raw) : {};

    c.set("session", session);

    await next();

    // Persist session back to cookie after handler runs
    const updated = c.get("session");
    if (updated && Object.keys(updated).length > 0) {
      // Default to secure cookies unless explicitly opted out via env var.
      // This works reliably in both Cloudflare Workers and Node.js contexts.
      const secure = c.env?.COOKIE_SECURE !== "false";

      setCookie(c, SESSION_COOKIE_NAME, encodeSession(updated), {
        path: "/",
        httpOnly: true,
        secure,
        sameSite: "Lax",
        maxAge: 24 * 60 * 60, // 24 hours (in seconds)
      });
    }
  });
}

/**
 * Destroy the session by clearing the cookie and the context variable.
 */
export function destroySession(c: Parameters<typeof deleteCookie>[0]) {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  // Also reset context variable so subsequent reads see an empty session
  (c as { set(key: "session", value: SessionData): void }).set("session", {});
}
