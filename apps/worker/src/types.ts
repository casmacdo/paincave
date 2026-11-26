export interface WorkerSecrets {
  UI_ADMIN_PASSWORD_HASH?: string;
  SESSION_SIGNING_SECRET?: string;
  BRIDGE_DEVICE_TOKEN?: string;
  MCP_BEARER_TOKEN?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
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
    requestId: string;
  };
}
