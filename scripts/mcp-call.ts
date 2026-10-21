// Usage: node scripts/mcp-call.ts <tool> [key=value ...] [--json '{...}'] [--url http://127.0.0.1:5302/mcp]
const args = process.argv.slice(2);
let url = "http://127.0.0.1:5302/mcp";
let tool: string | undefined;
const params: Record<string, unknown> = {};
let extra: Record<string, unknown> = {};

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--url") url = args[++i] ?? url;
  else if (arg === "--json") extra = JSON.parse(args[++i] ?? "{}") as Record<string, unknown>;
  else if (tool === undefined) tool = arg;
  else {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      process.stderr.write(`ERROR: expected key=value, got '${arg}'\n`);
      process.exit(2);
    }
    const key = arg.slice(0, eq);
    const raw = arg.slice(eq + 1);
    params[key] = raw === "true" ? true : raw === "false" ? false : /^-?\d+$/.test(raw) ? Number(raw) : raw;
  }
}

if (tool === undefined) {
  process.stderr.write("usage: node scripts/mcp-call.ts <tool> [key=value ...] [--json '{...}'] [--url <url>]\n");
  process.exit(2);
}

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: tool, arguments: { ...params, ...extra } },
  }),
});
const reply = (await response.json()) as {
  error?: { message: string };
  result?: { isError?: boolean; content?: { type: string; text?: string }[] };
};
if (reply.error) {
  process.stdout.write(`ERROR: ${reply.error.message}\n`);
  process.exit(1);
}
if (reply.result?.isError) process.stdout.write("TOOL ERROR:\n");
for (const item of reply.result?.content ?? []) {
  if (item.text !== undefined) process.stdout.write(item.text.endsWith("\n") ? item.text : `${item.text}\n`);
}
