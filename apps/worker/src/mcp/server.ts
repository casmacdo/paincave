import { Hono } from "hono";
import type { HonoAppContext } from "../types.js";
import { verifyMcpAuth } from "../lib/auth.js";
import { McpToolRegistry, handleStatelessMcpPost } from "./protocol.js";
import { registerReadTools } from "./read-tools.js";
import { registerWriteTools } from "./write-tools.js";

function buildRegistry(): McpToolRegistry {
  const registry = new McpToolRegistry();
  registerReadTools(registry);
  registerWriteTools(registry);
  return registry;
}

const TOOL_REGISTRY = buildRegistry();

export function createMcpRoutes(): Hono<HonoAppContext> {
  const router = new Hono<HonoAppContext>();

  router.all("/", async (c) => {
    const auth = await verifyMcpAuth(c.req.raw, c.env);
    if (!auth.ok) {
      if (auth.status === 401) {
        const origin = new URL(c.req.url).origin;
        c.header(
          "WWW-Authenticate",
          `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
        );
      }
      return c.json({ error: auth.error }, auth.status);
    }

    c.set("authMethod", auth.method);

    if (c.req.method === "POST") {
      return handleStatelessMcpPost(c.req.raw, TOOL_REGISTRY, c.env);
    }
    if (c.req.method === "DELETE") {
      return c.json({ ok: true }, 200);
    }
    return c.json(
      { error: "Method not allowed. Use POST for stateless Streamable HTTP MCP." },
      405
    );
  });

  return router;
}
