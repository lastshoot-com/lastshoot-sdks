#!/usr/bin/env node
import { LastShoot } from "@lastshoot/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  if (!process.env.LASTSHOOT_API_KEY) {
    console.error(
      "lastshoot-mcp: LASTSHOOT_API_KEY is not set. Add it to the MCP server's env config. " +
        "Get a key at https://www.lastshoot.com/dashboard",
    );
    process.exit(1);
  }
  const client = new LastShoot({ apiKey: process.env.LASTSHOOT_API_KEY, baseUrl: process.env.LASTSHOOT_BASE_URL });
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel: log only to stderr.
  console.error("lastshoot-mcp: ready on stdio");
}

main().catch((err) => {
  console.error("lastshoot-mcp: fatal:", err);
  process.exit(1);
});
