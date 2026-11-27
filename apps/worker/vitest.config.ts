import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig(async () => {
  const migrationsPath = path.join(__dirname, "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SIGNING_SECRET: "test-session-signing-secret-0123456789abcdef",
            GOOGLE_CLIENT_ID: "test-google-client-id",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
            BRIDGE_DEVICE_TOKEN: "test-bridge-device-token-0123456789abcdef",
            MCP_BEARER_TOKEN: "test-mcp-bearer-token-0123456789abcdef",
            STRAVA_CLIENT_ID: "test-strava-client-id",
            STRAVA_CLIENT_SECRET: "test-strava-client-secret",
          },
        },
      }),
    ],
    test: {
      include: ["test/**/*.test.ts"],
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
