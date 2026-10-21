/** `directories`: existing directories that were reported whole (moved or renamed in); absent when none. */
export type ChangeBatch = { paths: Set<string>; overflowed: boolean; directories?: Set<string> };

export type DebouncerOptions = {
  quietMs: number;
  maxWaitMs?: number;
  onFlush: (batch: ChangeBatch) => void;
};

/** Collects paths and emits them as one batch after a quiet period (or the max wait since the first path). */
export class ChangeDebouncer {
  private readonly quiet: number;
  private readonly maxWait: number;
  private readonly onFlush: (batch: ChangeBatch) => void;
  private batch: ChangeBatch = { paths: new Set(), overflowed: false };
  private quietTimer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;

  constructor(options: DebouncerOptions) {
    this.quiet = options.quietMs;
    this.maxWait = options.maxWaitMs ?? Math.max(3000, 6 * this.quiet);
    this.onFlush = options.onFlush;
  }

  /** Paths and directories held in the current batch (an overflow flag counts as one). */
  get buffered(): number {
    return this.batch.paths.size + (this.batch.directories?.size ?? 0) + (this.batch.overflowed ? 1 : 0);
  }

  add(path: string): void {
    this.batch.paths.add(path);
    this.arm();
  }

  /** A directory to scan for solutions (moved or renamed into a root). */
  addDirectory(path: string): void {
    (this.batch.directories ??= new Set()).add(path);
    this.arm();
  }

  /** The current batch lost events; consumers must reconcile instead of trusting the paths. */
  markOverflow(): void {
    this.batch.overflowed = true;
    this.arm();
  }

  /** Emit the current batch now; nothing happens when it is empty. */
  flush(): void {
    this.clear();
    if (this.batch.paths.size === 0 && !this.batch.overflowed && !this.batch.directories?.size) return;
    const batch = this.batch;
    this.batch = { paths: new Set(), overflowed: false };
    this.onFlush(batch);
  }

  /** Cancel the timers without flushing. */
  dispose(): void {
    this.clear();
  }

  private arm(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.flush(), this.quiet);
    this.maxTimer ??= setTimeout(() => this.flush(), this.maxWait);
  }

  private clear(): void {
    if (this.quietTimer) clearTimeout(this.quietTimer);
    if (this.maxTimer) clearTimeout(this.maxTimer);
    this.quietTimer = null;
    this.maxTimer = null;
  }
}
