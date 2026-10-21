import { homedir } from "node:os";

/** `%LOCALAPPDATA%/domra/index.db` (else `~/domra/index.db`), forward slashes. */
export function defaultIndexPath(): string {
  return `${process.env["LOCALAPPDATA"] ?? homedir()}/domra/index.db`.replace(/\\/g, "/");
}
