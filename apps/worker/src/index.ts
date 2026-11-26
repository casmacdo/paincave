import { createApp } from "./app.js";
import type { AppEnv } from "./types.js";

const app = createApp();

export default {
  fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    return Promise.resolve(app.fetch(request, env, ctx));
  },
} satisfies ExportedHandler<AppEnv>;
