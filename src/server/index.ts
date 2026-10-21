import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { startServer } from "./server.ts";

export const LAYER = "server";

async function main(): Promise<void> {
  const server = await startServer(loadConfig());
  process.stderr.write(`domra listening on http://127.0.0.1:${server.port}/mcp\n`);
  const shutdown = (): void => {
    server.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only start when run as the entry point, not when imported (the smoke test imports LAYER).
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`domra: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
