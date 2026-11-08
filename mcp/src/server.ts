import { LastShoot } from "@lastshoot/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Client, type ToolContext, type ToolDef, createTools } from "./tools.js";

export { createTools, PRODUCT_TO_MODEL_PROMPT, type Client, type ToolContext, type ToolDef, type ToolResult } from "./tools.js";

export const SERVER_NAME = "lastshoot";
export const SERVER_VERSION = "0.1.1";

const INSTRUCTIONS =
  "LastShoot AI product photography. Image inputs accept public URLs or local file paths (local files are uploaded " +
  "automatically). Compute tools wait for the result by default and return result_url, a temporary link that " +
  "expires within 24 hours. For long jobs pass wait=false and then call wait_for_job with the returned job_id and endpoint.";

interface ExtraLike {
  signal?: AbortSignal;
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }) => Promise<void>;
}

/** Build the per-call context: progress notifications only when the client sent a progressToken. */
export function makeContext(extra: ExtraLike | undefined): ToolContext {
  const token = extra?._meta?.progressToken;
  let last = -1;
  return {
    signal: extra?.signal,
    async progress(progress, message) {
      if (token === undefined || !extra?.sendNotification) return;
      const p = Math.max(0, Math.min(100, Math.round(progress)));
      if (p <= last) return; // MCP requires progress to increase with each notification
      last = p;
      try {
        await extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: p, total: 100, ...(message ? { message } : {}) },
        });
      } catch {
        // progress is best-effort
      }
    },
  };
}

export function registerTools(server: McpServer, tools: ToolDef[]): void {
  for (const t of tools) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: Record<string, unknown>, extra: ExtraLike) => t.handler(args, makeContext(extra))) as any,
    );
  }
}

/** Create the LastShoot MCP server. Pass a client (or a fake in tests); default reads LASTSHOOT_API_KEY. */
export function createServer(client?: Client): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, createTools(client ?? new LastShoot()));
  return server;
}
