/**
 * Concurrency Limiter
 *
 * Limits the number of simultaneous analysis tasks. When the limit is
 * reached, excess requests are queued and processed in FIFO order as
 * running tasks complete.
 *
 * Reference: SPEC.md §8.2
 */

/** Default maximum number of simultaneous analyses. */
const DEFAULT_MAX_CONCURRENCY = 10;

interface QueueEntry<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class ConcurrencyLimiter {
  private readonly maxConcurrency: number;
  private running = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly queue: QueueEntry<any>[] = [];

  constructor(maxConcurrency: number = DEFAULT_MAX_CONCURRENCY) {
    if (maxConcurrency < 1) {
      throw new Error("maxConcurrency must be at least 1");
    }
    this.maxConcurrency = maxConcurrency;
  }

  /** Number of tasks currently executing. */
  get runningCount(): number {
    return this.running;
  }

  /** Number of tasks waiting in the queue. */
  get queueLength(): number {
    return this.queue.length;
  }

  /**
   * Submit a task for execution.
   *
   * If the concurrency limit has not been reached the task runs
   * immediately; otherwise it is placed in a FIFO queue.
   *
   * @returns A promise that resolves with the task's return value.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.running < this.maxConcurrency) {
        this.execute({ task, resolve, reject });
      } else {
        this.queue.push({ task, resolve, reject });
      }
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private execute(entry: QueueEntry<any>): void {
    this.running++;
    entry
      .task()
      .then((value) => entry.resolve(value))
      .catch((err) => entry.reject(err))
      .finally(() => {
        this.running--;
        this.dequeue();
      });
  }

  private dequeue(): void {
    if (this.queue.length > 0 && this.running < this.maxConcurrency) {
      const next = this.queue.shift()!;
      this.execute(next);
    }
  }
}
