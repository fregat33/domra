import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const FILE_PATTERN = /^domra-\d{8}\.clef$/;

/** `%LOCALAPPDATA%/domra/logs` (else `~/domra/logs`), next to the default index. */
export function defaultLogDirectory(): string {
  return `${process.env["LOCALAPPDATA"] ?? homedir()}/domra/logs`.replace(/\\/g, "/");
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Local date as `YYYYMMDD`. */
function localDate(now: Date): string {
  return `${pad(now.getFullYear(), 4)}${pad(now.getMonth() + 1, 2)}${pad(now.getDate(), 2)}`;
}

/** Daily JSON-lines (CLEF) log file `domra-YYYYMMDD.clef` with retention by file count. */
export class LogFile {
  private day: string | null = null;
  private failed = false;

  /** `onFailure` is called at most once, with the first write error. */
  private readonly directory: string;
  private readonly retainedDays: number;
  private readonly onFailure: (message: string) => void;
  private readonly clock: () => Date;

  constructor(
    directory: string,
    retainedDays: number,
    onFailure: (message: string) => void,
    clock: () => Date = () => new Date(),
  ) {
    this.directory = directory;
    this.retainedDays = retainedDays;
    this.onFailure = onFailure;
    this.clock = clock;
    this.sweep();
  }

  write(message: string): void {
    try {
      const now = this.clock();
      const day = localDate(now);
      if (day !== this.day) {
        this.day = day;
        this.sweep();
      }
      appendFileSync(join(this.directory, `domra-${day}.clef`), `${this.format(now, message)}\n`);
    } catch (error) {
      if (this.failed) return;
      this.failed = true;
      try {
        this.onFailure(`domra: log file write failed: ${error instanceof Error ? error.message : String(error)}`);
      } catch {
        // a failing warn must not break logging callers
      }
    }
  }

  close(): void {
    // Every write is a synchronous append; nothing is held open.
  }

  private format(now: Date, message: string): string {
    const entry: Record<string, string> = { "@t": now.toISOString() };
    let text = message;
    if (text.startsWith("WARN ")) {
      entry["@l"] = "Warning";
      text = text.slice(5);
    } else if (text.startsWith("INFO ")) {
      text = text.slice(5);
    }
    entry["@m"] = text;
    return JSON.stringify(entry);
  }

  /** Deletes `domra-YYYYMMDD.clef` files beyond the newest `retainedDays`; `<= 0` keeps all. */
  private sweep(): void {
    try {
      mkdirSync(this.directory, { recursive: true });
      if (this.retainedDays <= 0) return;
      const files = readdirSync(this.directory).filter((name) => FILE_PATTERN.test(name)).sort().reverse();
      for (const name of files.slice(this.retainedDays)) {
        try {
          unlinkSync(join(this.directory, name));
        } catch {
          // best effort
        }
      }
    } catch {
      // the following append reports an unusable directory
    }
  }
}
