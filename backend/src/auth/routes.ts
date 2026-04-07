import { Hono } from "hono";
import type { Context, Next } from "hono";
import { encrypt, decrypt, generateRandomHex } from "./crypto.js";
import { destroySession } from "./session.js";
import type { UserInfo, AuthError } from "@route-atlas/shared";

const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER_URL = "https://api.github.com/user";
const GITHUB_API_COPILOT_URL =
  "https://api.github.com/copilot_internal/v2/token";

type EnvBindings = Record<string, unknown>;

function getClientId(env?: EnvBindings): string {
  const id =
    (env?.["GITHUB_CLIENT_ID"] as string | undefined) ??
    process.env["GITHUB_CLIENT_ID"];
  if (!id) {
    throw new Error("GITHUB_CLIENT_ID environment variable is not set");
  }
  return id;
}

function getClientSecret(env?: EnvBindings): string {
  const secret =
    (env?.["GITHUB_CLIENT_SECRET"] as string | undefined) ??
    process.env["GITHUB_CLIENT_SECRET"];
  if (!secret) {
    throw new Error("GITHUB_CLIENT_SECRET environment variable is not set");
  }
  return secret;
}

export async function exchangeCodeForToken(
  code: string,
  env?: EnvBindings,
  redirectUri?: string,
): Promise<string> {
  const body: Record<string, string> = {
    client_id: getClientId(env),
    client_secret: getClientSecret(env),
    code,
  };
  if (redirectUri) {
    body["redirect_uri"] = redirectUri;
  }
  const response = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = (await response.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error || !data.access_token) {
    throw new Error(
      data.error_description ?? data.error ?? "Failed to exchange code",
    );
  }

  return data.access_token;
}

export async function fetchGitHubUser(accessToken: string): Promise<UserInfo> {
  const response = await fetch(GITHUB_API_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    login: string;
    avatar_url: string;
    name: string | null;
  };

  return {
    login: data.login,
    avatarUrl: data.avatar_url,
    name: data.name,
  };
}

export async function checkCopilotAccess(
  accessToken: string,
): Promise<boolean> {
  try {
    const response = await fetch(GITHUB_API_COPILOT_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function createAuthRouter(): Hono {
  const router = new Hono();

  // GET /api/auth/github - Redirect to GitHub OAuth authorize URL
  router.get("/github", (c) => {
    try {
      const env = c.env as EnvBindings | undefined;
      const clientId = getClientId(env);
      const callbackUrl =
        (env?.["OAUTH_CALLBACK_URL"] as string | undefined) ??
        process.env["OAUTH_CALLBACK_URL"] ??
        "http://localhost:3000/api/auth/callback";

      // Generate CSRF state token
      const state = generateRandomHex(16);
      const session = c.get("session");
      session.oauthState = state;
      c.set("session", session);

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        scope: "repo read:user",
        state,
      });
      return c.redirect(`${GITHUB_OAUTH_AUTHORIZE_URL}?${params.toString()}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      const errorResponse: AuthError = {
        error: "config_error",
        message,
      };
      return c.json(errorResponse, 500);
    }
  });

  // GET /api/auth/callback - Handle OAuth callback
  router.get("/callback", async (c) => {
    const code = c.req.query("code");
    const error = c.req.query("error");
    const state = c.req.query("state");

    if (error) {
      return c.redirect("/login?error=oauth_denied");
    }

    if (!code) {
      return c.redirect("/login?error=missing_code");
    }

    // Verify CSRF state parameter
    const session = c.get("session");
    const expectedState = session.oauthState;
    delete session.oauthState;
    if (!state || state !== expectedState) {
      c.set("session", session);
      return c.redirect("/login?error=state_mismatch");
    }

    try {
      const cbEnv = c.env as EnvBindings | undefined;
      const callbackUrl =
        (cbEnv?.["OAUTH_CALLBACK_URL"] as string | undefined) ??
        process.env["OAUTH_CALLBACK_URL"] ??
        "http://localhost:3000/api/auth/callback";
      const accessToken = await exchangeCodeForToken(
        code,
        cbEnv,
        callbackUrl,
      );

      // Fetch user info to validate the token
      const user = await fetchGitHubUser(accessToken);

      // Check Copilot subscription
      const hasCopilot = await checkCopilotAccess(accessToken);

      // Encrypt and store token in session
      const env = c.env as EnvBindings | undefined;
      const sessionSecret = env?.["SESSION_SECRET"] as string | undefined;
      const encryptedToken = await encrypt(accessToken, sessionSecret);
      session.encryptedToken = encryptedToken;
      session.user = user;
      session.hasCopilot = hasCopilot;
      c.set("session", session);

      return c.redirect("/");
    } catch (err) {
      c.set("session", session);
      const detail =
        err instanceof Error ? err.message : "unknown";
      return c.redirect(
        `/login?error=token_exchange_failed&detail=${encodeURIComponent(detail)}`,
      );
    }
  });

  // GET /api/auth/me - Get current user info
  router.get("/me", (c) => {
    const session = c.get("session");
    if (!session.user || !session.encryptedToken) {
      const errorResponse: AuthError = {
        error: "unauthorized",
        message: "Not authenticated",
      };
      return c.json(errorResponse, 401);
    }

    const response: UserInfo & { hasCopilot: boolean } = {
      ...session.user,
      hasCopilot: session.hasCopilot ?? false,
    };
    return c.json(response);
  });

  // POST /api/auth/logout - Destroy session
  router.post("/logout", async (c) => {
    await destroySession(c);
    return c.json({ message: "Logged out" });
  });

  return router;
}

/**
 * Middleware to require authentication.
 * Returns the decrypted access token for downstream handlers.
 */
export async function requireAuth(c: Context, next: Next) {
  const session = c.get("session");
  if (!session?.user || !session?.encryptedToken) {
    const errorResponse: AuthError = {
      error: "unauthorized",
      message: "Authentication required",
    };
    return c.json(errorResponse, 401);
  }

  try {
    // Decrypt token to verify it's still valid
    const env = c.env as Record<string, unknown> | undefined;
    const sessionSecret = env?.["SESSION_SECRET"] as string | undefined;
    await decrypt(session.encryptedToken, sessionSecret);
    await next();
  } catch {
    const errorResponse: AuthError = {
      error: "unauthorized",
      message: "Invalid session token",
    };
    return c.json(errorResponse, 401);
  }
}
