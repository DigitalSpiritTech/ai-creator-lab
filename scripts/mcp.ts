/**
 * Stdio MCP server for AI Creator Lab: `npm run mcp`. Opens the store in `STUDIO_DATA_DIR`
 * (default `.data`), loads `.env.local` when present, and serves the tool registry. Keys come from
 * the environment or the Settings secrets file in the data directory. Stdout carries only the MCP
 * protocol; every log line goes to stderr.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "@/server/mcp/server";
import { openStore } from "@/server/store";
import { createGenerationContext, createToolContext } from "@/server/tools";

const log = (line: string) => process.stderr.write(`${line}\n`);
for (const method of ["log", "info", "debug", "warn"] as const) console[method] = (...args: unknown[]) => log(args.map(String).join(" "));

async function main(): Promise<void> {
  const envFile = resolve(process.cwd(), ".env.local");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const store = openStore(resolve(process.env.STUDIO_DATA_DIR || ".data"));
  const server = createMcpServer(createToolContext(store, createGenerationContext(store)), { log });
  const shutdown = async () => {
    await server.close().catch(() => undefined);
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
  log(`[mcp] AI Creator Lab MCP server ready on stdio, data in ${store.dataDir}`);
}

main().catch((error: unknown) => {
  log(`[mcp] could not start: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
