import { randomBytes } from "node:crypto";

export const PAGER_CAPACITY = 128;
export const PAGER_TTL_MS = 30 * 60 * 1000;

export type PagerOptions = {
  capacity?: number;
  ttlMs?: number;
  /** Milliseconds clock; injected by tests. */
  now?: () => number;
  /** Random byte source; injected by tests. */
  random?: (size: number) => Uint8Array;
};

type Entry = { label: string; lines: string[]; offset: number; pageSize: number; created: number };

/** In-memory result pages addressed by cursor. */
export class Pager {
  private readonly entries = new Map<string, Entry>();
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly random: (size: number) => Uint8Array;

  constructor(options: PagerOptions = {}) {
    this.capacity = options.capacity ?? PAGER_CAPACITY;
    this.ttlMs = options.ttlMs ?? PAGER_TTL_MS;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? randomBytes;
  }

  /** The first `limit` lines, then a `next_page` trailer when lines remain. */
  appendPage(lines: string[], limit: number, label: string): string {
    return this.page(lines, 0, Math.max(1, limit), label);
  }

  /** The next page of a stored result, or null when the cursor is unknown or expired. */
  take(cursor: string, limit?: number): string | null {
    const key = cursor.trim();
    if (key === "") return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.now() - entry.created >= this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    const pageSize = limit === undefined ? entry.pageSize : Math.max(1, limit);
    return `Continued: ${entry.label}\n${this.page(entry.lines, entry.offset, pageSize, entry.label)}`;
  }

  private page(lines: string[], offset: number, pageSize: number, label: string): string {
    const end = offset + pageSize;
    let text = lines.slice(offset, end).map((line) => `${line}\n`).join("");
    if (lines.length > end) {
      const cursor = this.store({ label, lines, offset: end, pageSize, created: this.now() });
      text += `  ... ${lines.length - end} more (next_page cursor=${cursor})\n`;
    }
    return text;
  }

  private store(entry: Entry): string {
    const now = this.now();
    for (const [key, value] of this.entries) {
      if (now - value.created >= this.ttlMs) this.entries.delete(key);
    }
    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    let cursor: string;
    do {
      cursor = Buffer.from(this.random(5)).toString("hex");
    } while (this.entries.has(cursor));
    this.entries.set(cursor, entry);
    return cursor;
  }
}
