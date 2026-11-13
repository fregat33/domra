export type StallOptions = {
  warn: (message: string) => void;
  warnMs?: number;
  longMs?: number;
  intervalMs?: number;
  now?: () => Date;
};

const pad = (n: number): string => String(n).padStart(2, "0");

/** `HH:mm:ss` of a local time. */
export function clock(at: Date): string {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Measures how long the event loop was blocked, by the lateness of an interval timer, and names the work marked meanwhile. */
export class StallMonitor {
  private readonly warn: (message: string) => void;
  private readonly warnMs: number;
  private readonly longMs: number;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | null = null;
  private last = 0;
  private marked: string[] = [];
  private over = 0;
  private overLong = 0;
  private longest: { ms: number; at: Date } | null = null;

  constructor(options: StallOptions) {
    this.warn = options.warn;
    this.warnMs = options.warnMs ?? 3000;
    this.longMs = options.longMs ?? 10000;
    this.intervalMs = options.intervalMs ?? 250;
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer !== null) return;
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Remember work that started since the previous tick. */
  mark(what: string): void {
    this.marked.push(what);
  }

  /** Record a measured stall; below `warnMs` nothing is recorded. */
  observe(stallMs: number): void {
    if (stallMs < this.warnMs) return;
    this.over++;
    if (stallMs >= this.longMs) this.overLong++;
    if (this.longest === null || stallMs > this.longest.ms) {
      let at: Date;
      try {
        at = this.now();
      } catch {
        at = new Date();
      }
      this.longest = { ms: stallMs, at };
    }
    const what = this.marked.length > 0 ? this.marked.join(", ") : "none";
    this.marked = [];
    try {
      this.warn(`WARN domra: Event loop stalled ${(stallMs / 1000).toFixed(1)}s; last work: ${what}`);
    } catch {
      // a log failure never reaches the loop
    }
  }

  line(): string {
    const warnS = String(this.warnMs / 1000);
    if (this.longest === null) return `Stalls: none over ${warnS}s`;
    return `Stalls: longest ${(this.longest.ms / 1000).toFixed(1)}s at ${clock(this.longest.at)}, ${this.over} over ${warnS}s, ${this.overLong} over ${this.longMs / 1000}s since start`;
  }

  private tick(): void {
    const at = performance.now();
    const stall = at - this.last - this.intervalMs;
    this.last = at;
    if (stall >= this.warnMs) {
      try {
        this.observe(stall);
      } catch {
        // never throws into the loop
      }
    }
    if (this.marked.length > 0) this.marked = [];
  }
}
