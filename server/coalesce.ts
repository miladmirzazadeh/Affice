// Keeps a GET route that starts a process (git, `claude`) from running more often than needed (SEC-09).
// A refresh that is already running is shared by every caller; a refresh that finished or started within
// `gapMs` is not repeated: the caller gets the held answer instead.

export class RefreshGate {
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly lastStart = new Map<string, number>();

  constructor(
    private readonly gapMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** `refresh` runs the process; `held` answers from what is already known. */
  async run<T>(key: string, refresh: () => Promise<T>, held: () => Promise<T> | T): Promise<T> {
    const inflight = this.running.get(key);
    if (inflight) return (await inflight) as T;
    const last = this.lastStart.get(key);
    if (last !== undefined && this.now() - last < this.gapMs) return held();
    this.lastStart.set(key, this.now());
    const promise = refresh();
    this.running.set(key, promise);
    try {
      return await promise;
    } finally {
      this.running.delete(key);
    }
  }
}
