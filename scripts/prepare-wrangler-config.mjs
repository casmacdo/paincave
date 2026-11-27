import { readFile, writeFile } from "node:fs/promises";

const databaseId = process.env.PAINCAVE_D1_DATABASE_ID?.trim();
const buildSha = process.env.BUILD_SHA?.trim();

if (!databaseId) {
  throw new Error("PAINCAVE_D1_DATABASE_ID is required");
}

const sourcePath = new URL("../apps/worker/wrangler.jsonc", import.meta.url);
const outputPath = new URL("../apps/worker/wrangler.local.jsonc", import.meta.url);
const config = JSON.parse(await readFile(sourcePath, "utf8"));

const database = config.d1_databases?.find((binding) => binding.binding === "DB");
if (!database) {
  throw new Error("apps/worker/wrangler.jsonc does not define the DB binding");
}

database.database_id = databaseId;
config.vars = {
  ...config.vars,
  APP_ENV: "production",
  BUILD_SHA: buildSha || "unknown",
};

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
