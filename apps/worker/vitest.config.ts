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
            UI_ADMIN_PASSWORD_HASH:
              "pbkdf2_sha256$100000$000102030405060708090a0b0c0d0e0f$bf8cf8fc8d2865c59c8e003454e68397122aa1806ae8b54dbbd5909a780dde61",
            SESSION_SIGNING_SECRET: "test-session-signing-secret-0123456789abcdef",
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
