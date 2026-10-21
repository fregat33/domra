// Claude Code PostToolUse hook: reports compiler errors of the file just edited via the domra server.
// Reads the hook JSON from stdin; always exits 0 and prints nothing unless the file has errors or warnings.
import { isAbsolute, resolve } from "node:path";

const URL_DEFAULT = "http://localhost:5302/mcp";
const SUMMARY = /^Diagnostics for .*: (\d+) errors, (\d+) warnings/;

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(): Promise<void> {
  const raw = (await readStdin()).trim();
  if (raw === "") return;
  const input = JSON.parse(raw) as { tool_input?: { file_path?: unknown; path?: unknown }; cwd?: unknown };
  const given = input.tool_input?.file_path ?? input.tool_input?.path;
  if (typeof given !== "string" || !/\.(ts|tsx|mts|cts)$/i.test(given)) return;
  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  const target = isAbsolute(given) ? given : resolve(cwd, given);

  const response = await fetch(process.env["DOMRA_URL"] ?? URL_DEFAULT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "get_diagnostics", arguments: { target, minSeverity: "error", limit: 30 } },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const reply = (await response.json()) as { error?: unknown; result?: { isError?: boolean; content?: { text?: string }[] } };
  const text = reply.result?.content?.[0]?.text;
  if (reply.error || reply.result?.isError || typeof text !== "string") return;
  const counts = SUMMARY.exec(text);
  if (!counts || (Number(counts[1]) === 0 && Number(counts[2]) === 0)) return;
  const additionalContext = `domra get_diagnostics on the file just edited (compiler only):\n${text.trimEnd()}`;
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext } }));
}

try {
  await main();
} catch {
  // a hook must never block the edit
}
process.exit(0);
