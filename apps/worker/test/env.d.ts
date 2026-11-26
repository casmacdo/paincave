import type { D1Migration } from "@cloudflare/vitest-plugin";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS?: D1Migration[];
      UI_ADMIN_PASSWORD_HASH?: string;
      SESSION_SIGNING_SECRET?: string;
      BRIDGE_DEVICE_TOKEN?: string;
      MCP_BEARER_TOKEN?: string;
      STRAVA_CLIENT_ID?: string;
      STRAVA_CLIENT_SECRET?: string;
    }
  }
}
