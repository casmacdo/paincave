import { z } from "zod";
import type { AppEnv } from "../types.js";
import { DEFAULT_OWNER_USER_ID } from "../lib/better-auth.js";

export interface McpToolDefinition<TInput extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: TInput;
  handler: (args: z.infer<TInput>, env: AppEnv, userId: string) => Promise<unknown>;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const SUPPORTED_PROTOCOL_VERSION = "2025-03-26";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  SUPPORTED_PROTOCOL_VERSION,
  "2025-06-18",
]);

/**
 * Optional integer input helper for LLM tool callers (e.g. Gemini) that may
 * send stringified numbers, empty strings, or null for optional arguments.
 */
export function optionalCoercedInt(min: number, max: number) {
  return z.preprocess(
    (value) => {
      if (value === null || value === "") return undefined;
      if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
        return Number(value.trim());
      }
      return value;
    },
    z.number().int().min(min).max(max).optional()
  );
}

export function optionalCoercedBoolean() {
  return z.preprocess(
    (value) => {
      if (value === null || value === "") return undefined;
      if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
      }
      return value;
    },
    z.boolean().optional()
  );
}

export function optionalEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (value) => (value === null || value === "" ? undefined : value),
    z.enum(values).optional()
  );
}

export class McpToolRegistry {
  private readonly tools = new Map<string, McpToolDefinition>();

  register<TInput extends z.ZodObject<z.ZodRawShape>>(
    name: string,
    config: {
      description: string;
      inputSchema: TInput;
    },
    handler: (args: z.infer<TInput>, env: AppEnv, userId: string) => Promise<unknown>
  ): void {
    this.tools.set(name, {
      name,
      description: config.description,
      inputSchema: config.inputSchema,
      handler: handler as (args: unknown, env: AppEnv, userId: string) => Promise<unknown>,
    });
  }

  listTools(): {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[] {
    const out: {
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
    }[] = [];

    for (const tool of this.tools.values()) {
      const jsonSchema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>;
      delete jsonSchema["$schema"];
      out.push({
        name: tool.name,
        description: tool.description,
        inputSchema: jsonSchema,
      });
    }
    return out;
  }

  async callTool(
    name: string,
    rawArgs: unknown,
    env: AppEnv,
    userId = DEFAULT_OWNER_USER_ID
  ): Promise<{
    isError: boolean;
    content: { type: "text"; text: string }[];
    structuredContent?: unknown;
  }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      };
    }

    const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "Invalid tool arguments",
              issues: parsed.error.issues,
            }),
          },
        ],
      };
    }

    try {
      const result = await tool.handler(parsed.data, env, userId);
      return {
        isError: false,
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: message }) }],
      };
    }
  }
}

function jsonRpcOk(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: unknown,
  code: number,
  message: string
): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function dispatchSingleRpc(
  req: JsonRpcRequest,
  registry: McpToolRegistry,
  env: AppEnv,
  userId: string
): Promise<Record<string, unknown> | null> {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return jsonRpcError(req.id, -32600, "Invalid Request");
  }

  const isNotification = req.id === undefined || req.id === null;
  const method = req.method;

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return isNotification ? null : jsonRpcOk(req.id, {});
  }

  if (method === "initialize") {
    const params =
      req.params && typeof req.params === "object"
        ? (req.params as { protocolVersion?: unknown })
        : {};
    const requestedVersion =
      typeof params.protocolVersion === "string"
        ? params.protocolVersion
        : SUPPORTED_PROTOCOL_VERSION;
    const negotiatedVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)
      ? requestedVersion
      : SUPPORTED_PROTOCOL_VERSION;
    return jsonRpcOk(req.id, {
      protocolVersion: negotiatedVersion,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: "paincave-mcp",
        version: "0.1.0",
      },
    });
  }

  if (method === "ping") {
    return jsonRpcOk(req.id, {});
  }

  if (method === "tools/list") {
    return jsonRpcOk(req.id, {
      tools: registry.listTools(),
    });
  }

  if (method === "tools/call") {
    const params =
      req.params && typeof req.params === "object"
        ? (req.params as { name?: unknown; arguments?: unknown })
        : {};
    if (typeof params.name !== "string") {
      return jsonRpcError(req.id, -32602, "tools/call requires string 'name'");
    }
    const callResult = await registry.callTool(params.name, params.arguments, env, userId);
    return jsonRpcOk(req.id, callResult);
  }

  if (isNotification) return null;
  return jsonRpcError(req.id, -32601, `Method not found: ${method}`);
}

/**
 * Stateless Streamable HTTP MCP handler compatible with Cloudflare Workers (zero Durable Objects).
 */
export async function handleStatelessMcpPost(
  request: Request,
  registry: McpToolRegistry,
  env: AppEnv,
  userId = DEFAULT_OWNER_USER_ID
): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json(jsonRpcError(null, -32700, "Parse error"), { status: 400 });
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return Response.json(jsonRpcError(null, -32600, "Empty batch"), { status: 400 });
    }
    const responses: Record<string, unknown>[] = [];
    for (const item of payload) {
      const res = await dispatchSingleRpc(
        item && typeof item === "object" ? (item as JsonRpcRequest) : {},
        registry,
        env,
        userId
      );
      if (res !== null) responses.push(res);
    }
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    return Response.json(responses, { status: 200 });
  }

  if (!payload || typeof payload !== "object") {
    return Response.json(jsonRpcError(null, -32600, "Invalid Request"), { status: 400 });
  }

  const res = await dispatchSingleRpc(payload, registry, env, userId);
  if (res === null) {
    return new Response(null, { status: 202 });
  }
  return Response.json(res, { status: 200 });
}
