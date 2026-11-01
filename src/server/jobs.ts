/** Progress of the startup warm-up, shown by `status`. */
export type WarmUpState = { ran: boolean; total: number; done: number; current: string | null; warmed: number; fresh: number; failed?: string[] };

type Job = { name: string; run: () => void | Promise<void>; resolve: () => void };

/** FIFO queue of jobs, one at a time, each started from `setImmediate` so requests interleave. An async job is awaited. */
export class JobQueue {
  private readonly queue: Job[] = [];
  private readonly waiters: (() => void)[] = [];
  private running = false;
  private unfinished = 0;
  private completed: { name: string; at: Date } | null = null;
  private readonly warn: (message: string) => void;

  constructor(warn: (message: string) => void = () => undefined) {
    this.warn = warn;
  }

  /** Jobs enqueued and not finished (the running one included). */
  get pending(): number {
    return this.unfinished;
  }

  get lastCompleted(): { name: string; at: Date } | null {
    return this.completed;
  }

  /** The promise resolves after the job ran (also when it threw; the error goes to `warn`). */
  enqueue(name: string, run: () => void | Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push({ name, run, resolve });
      this.unfinished++;
      this.schedule();
    });
  }

  /** Resolves when the queue is empty. */
  idle(): Promise<void> {
    if (this.unfinished === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private schedule(): void {
    if (this.running || this.queue.length === 0) return;
    this.running = true;
    setImmediate(() => this.runNext());
  }

  private runNext(): void {
    const job = this.queue.shift()!;
    let result: void | Promise<void>;
    try {
      result = job.run();
    } catch (error) {
      this.fail(job, error);
      this.finish(job);
      return;
    }
    if (!(result instanceof Promise)) {
      this.finish(job);
      return;
    }
    result.then(
      () => undefined,
      (error: unknown) => this.fail(job, error),
    ).then(() => this.finish(job));
  }

  private fail(job: Job, error: unknown): void {
    this.warn(`domra: job '${job.name}' failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  private finish(job: Job): void {
    this.completed = { name: job.name, at: new Date() };
    this.unfinished--;
    this.running = false;
    job.resolve();
    if (this.unfinished === 0) for (const waiter of this.waiters.splice(0)) waiter();
    this.schedule();
  }
}
