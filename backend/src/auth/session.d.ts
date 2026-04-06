import type { UserInfo } from "@route-atlas/shared";

declare module "express-session" {
  interface SessionData {
    encryptedToken: string;
    user: UserInfo;
    hasCopilot: boolean;
    oauthState?: string;
  }
}
