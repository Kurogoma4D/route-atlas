import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "./crypto.js";
import type { UserInfo, AuthError } from "@route-atlas/shared";

const GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_USER_URL = "https://api.github.com/user";
const GITHUB_API_COPILOT_URL =
  "https://api.github.com/copilot_internal/v2/token";

function getClientId(): string {
  const id = process.env["GITHUB_CLIENT_ID"];
  if (!id) {
    throw new Error("GITHUB_CLIENT_ID environment variable is not set");
  }
  return id;
}

function getClientSecret(): string {
  const secret = process.env["GITHUB_CLIENT_SECRET"];
  if (!secret) {
    throw new Error("GITHUB_CLIENT_SECRET environment variable is not set");
  }
  return secret;
}

export async function exchangeCodeForToken(code: string): Promise<string> {
  const response = await fetch(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: getClientId(),
      client_secret: getClientSecret(),
      code,
    }),
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

export function createAuthRouter(): Router {
  const router = Router();

  // GET /api/auth/github - Redirect to GitHub OAuth authorize URL
  router.get("/github", (req: Request, res: Response) => {
    try {
      const clientId = getClientId();
      const callbackUrl =
        process.env["OAUTH_CALLBACK_URL"] ??
        "http://localhost:3000/api/auth/callback";

      // Generate CSRF state token
      const state = randomBytes(16).toString("hex");
      req.session.oauthState = state;

      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callbackUrl,
        // repo: needed for reading private repository contents (SPEC.md §4.1)
        // read:user: needed for reading user profile information
        scope: "repo read:user",
        state,
      });
      res.redirect(`${GITHUB_OAUTH_AUTHORIZE_URL}?${params.toString()}`);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Internal server error";
      const errorResponse: AuthError = {
        error: "config_error",
        message,
      };
      res.status(500).json(errorResponse);
    }
  });

  // GET /api/auth/callback - Handle OAuth callback
  router.get("/callback", async (req: Request, res: Response) => {
    const code = req.query["code"] as string | undefined;
    const error = req.query["error"] as string | undefined;
    const state = req.query["state"] as string | undefined;

    if (error) {
      res.redirect("/login?error=oauth_denied");
      return;
    }

    if (!code) {
      res.redirect("/login?error=missing_code");
      return;
    }

    // Verify CSRF state parameter
    const expectedState = req.session.oauthState;
    delete req.session.oauthState;
    if (!state || state !== expectedState) {
      res.redirect("/login?error=state_mismatch");
      return;
    }

    try {
      const accessToken = await exchangeCodeForToken(code);

      // Fetch user info to validate the token
      const user = await fetchGitHubUser(accessToken);

      // Check Copilot subscription
      const hasCopilot = await checkCopilotAccess(accessToken);

      // Encrypt and store token in session
      const encryptedToken = encrypt(accessToken);
      req.session.encryptedToken = encryptedToken;
      req.session.user = user;
      req.session.hasCopilot = hasCopilot;

      req.session.save((err) => {
        if (err) {
          res.redirect("/login?error=session_error");
          return;
        }
        res.redirect("/");
      });
    } catch {
      res.redirect("/login?error=token_exchange_failed");
    }
  });

  // GET /api/auth/me - Get current user info
  router.get("/me", (req: Request, res: Response) => {
    if (!req.session.user || !req.session.encryptedToken) {
      const errorResponse: AuthError = {
        error: "unauthorized",
        message: "Not authenticated",
      };
      res.status(401).json(errorResponse);
      return;
    }

    const response: UserInfo & { hasCopilot: boolean } = {
      ...req.session.user,
      hasCopilot: req.session.hasCopilot ?? false,
    };
    res.json(response);
  });

  // POST /api/auth/logout - Destroy session
  router.post("/logout", (req: Request, res: Response) => {
    req.session.destroy((err) => {
      if (err) {
        const errorResponse: AuthError = {
          error: "logout_failed",
          message: "Failed to destroy session",
        };
        res.status(500).json(errorResponse);
        return;
      }
      res.clearCookie("connect.sid");
      res.json({ message: "Logged out" });
    });
  });

  return router;
}

/**
 * Middleware to require authentication.
 * Returns the decrypted access token for downstream handlers.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user || !req.session.encryptedToken) {
    const errorResponse: AuthError = {
      error: "unauthorized",
      message: "Authentication required",
    };
    res.status(401).json(errorResponse);
    return;
  }

  try {
    // Decrypt token to verify it's still valid
    decrypt(req.session.encryptedToken);
    next();
  } catch {
    const errorResponse: AuthError = {
      error: "unauthorized",
      message: "Invalid session token",
    };
    res.status(401).json(errorResponse);
  }
}
