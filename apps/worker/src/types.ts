export interface WorkerSecrets {
  UI_ADMIN_PASSWORD_HASH?: string;
  SESSION_SIGNING_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  ALLOWED_OWNER_EMAIL?: string;
  ALLOWED_USER_EMAILS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BRIDGE_DEVICE_TOKEN?: string;
  MCP_BEARER_TOKEN?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  PUBLIC_APP_URL?: string;
}

/**
 * Generated Cloudflare Env (from `wrangler types`) augmented with secret bindings
 * provisioned via `wrangler secret put`.
 */
export type AppEnv = Env & WorkerSecrets;

export interface HonoAppContext {
  Bindings: AppEnv;
  Variables: {
    authMethod: "session" | "bridge" | "bearer" | "oauth" | "none";
    userId: string;
    requestId: string;
  };
}
