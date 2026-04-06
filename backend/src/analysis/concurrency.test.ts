import { describe, it, expect } from "vitest";
import { ConcurrencyLimiter } from "./concurrency.js";

/** Helper: create a task that resolves when `release` is called. */
function createControllableTask<T = void>(
  value?: T,
): { task: () => Promise<T>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = async () => {
    await gate;
    return value as T;
  };
  return { task, release };
}

describe("ConcurrencyLimiter", () => {
  it("throws if maxConcurrency < 1", () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
    expect(() => new ConcurrencyLimiter(-1)).toThrow();
  });

  it("runs tasks immediately when under the limit", async () => {
    const limiter = new ConcurrencyLimiter(3);
    const result = await limiter.run(async () => 42);
    expect(result).toBe(42);
  });

  it("queues tasks that exceed the limit and runs them when slots free up", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const order: number[] = [];

    const t1 = createControllableTask(1);
    const t2 = createControllableTask(2);
    const t3 = createControllableTask(3);

    const p1 = limiter.run(async () => {
      await t1.task();
      order.push(1);
      return 1;
    });
    const p2 = limiter.run(async () => {
      await t2.task();
      order.push(2);
      return 2;
    });
    const p3 = limiter.run(async () => {
      await t3.task();
      order.push(3);
      return 3;
    });

    // t1 and t2 are running, t3 is queued
    expect(limiter.runningCount).toBe(2);
    expect(limiter.queueLength).toBe(1);

    // Release t1 — frees a slot for t3
    t1.release();
    await p1;

    // After microtask settles, t3 should be running
    // We need a tick for the .finally handler
    await new Promise((r) => setTimeout(r, 0));
    expect(limiter.runningCount).toBe(2);
    expect(limiter.queueLength).toBe(0);

    t2.release();
    await p2;

    t3.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it("propagates task rejections", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const error = new Error("boom");

    await expect(
      limiter.run(async () => {
        throw error;
      }),
    ).rejects.toThrow("boom");

    // Slot should be freed after rejection
    expect(limiter.runningCount).toBe(0);
  });

  it("processes queued tasks even after a prior task rejects", async () => {
    const limiter = new ConcurrencyLimiter(1);

    const failing = limiter.run(async () => {
      throw new Error("fail");
    });

    const succeeding = limiter.run(async () => "ok");

    await expect(failing).rejects.toThrow("fail");
    await expect(succeeding).resolves.toBe("ok");
  });

  it("handles high concurrency (stress test)", async () => {
    const limiter = new ConcurrencyLimiter(3);
    const results: number[] = [];
    const promises: Promise<void>[] = [];

    for (let i = 0; i < 20; i++) {
      promises.push(
        limiter.run(async () => {
          // Simulate async work
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          results.push(i);
        }),
      );
    }

    await Promise.all(promises);
    expect(results).toHaveLength(20);
  });
});
