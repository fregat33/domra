// Usage: node scripts/domra-cli.ts <command> <root> [args] [options]   (see `help`)
import { runCliAsync } from "../src/cli/cli.ts";

void runCliAsync(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
}).then((code) => {
  process.exitCode = code;
});
