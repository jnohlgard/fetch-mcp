/**
 * A process-wide counting semaphore that bounds how many outbound fetches may
 * be in flight at once. A limit of 0 means unlimited, in which case
 * acquire/release are no-ops.
 */
export class RateLimiter {
  readonly limit: number;
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(limit: number) {
    this.limit = Math.max(0, Math.floor(limit));
  }

  async acquire(): Promise<void> {
    if (this.limit < 1) return;
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    if (this.limit < 1) return;
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const DEFAULT_MAX_CONCURRENT_FETCHES = 10;

/**
 * Builds the process-wide fetch limiter from MAX_CONCURRENT_FETCHES
 * (default: 10 concurrent outbound fetches; 0 disables the cap). Read at
 * process start, like other module-level environment settings.
 */
export function createFetchRateLimiter(): RateLimiter {
  const parsed = Number.parseInt(process.env.MAX_CONCURRENT_FETCHES ?? String(DEFAULT_MAX_CONCURRENT_FETCHES));
  return new RateLimiter(Number.isNaN(parsed) ? DEFAULT_MAX_CONCURRENT_FETCHES : parsed);
}
