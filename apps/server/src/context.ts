import type { Db } from "./db/client.js";
import type { SecretBox } from "./lib/crypto.js";

export interface AppConfig {
  appUrl: string;
  sessionTtlDays: number;
  secureCookies: boolean;
  shopify: {
    apiKey?: string;
    apiSecret?: string;
    scopes: string;
    apiVersion: string;
  };
}

/** Everything a request handler needs; injected so tests build isolated apps. */
export interface Deps {
  db: Db;
  secrets: SecretBox;
  config: AppConfig;
  /** outbound HTTP (Shopify etc.) — swapped for a fake in tests. */
  fetch: typeof fetch;
}

export interface AuthInfo {
  userId: string;
  workspaceId: string;
  role: "owner" | "admin" | "member";
  sessionKind: "web" | "extension";
}

export type AppEnv = {
  Variables: {
    deps: Deps;
    auth: AuthInfo;
  };
};
