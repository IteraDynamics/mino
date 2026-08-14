import { describe, expect, it, vi } from "vitest";
import { NonOverlappingWorkerLoop } from "../../src/production/non-overlapping-worker-loop.js";

function fakeTimer(): {
  readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimer: (timer: NodeJS.Timeout) => void;
  readonly callbacks: Array<() => void>;
  readonly delays: number[];
} {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  return {
    callbacks,
    delays,
    setTimer(callback, delayMs) {
      callbacks.push(callback);
      delays.push(delayMs);
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    },
    clearTimer: () => undefined,
  };
}

describe("NonOverlappingWorkerLoop", () => {
  it("rejects invalid intervals", () => {
    expect(
      () => new NonOverlappingWorkerLoop({ intervalMs: 0, run: async () => undefined }),
    ).toThrow(/positive integer/i);
  });

  it("refuses an overlapping manual run and schedules only after completion", async () => {
    const timer = fakeTimer();
    let release: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const loop = new NonOverlappingWorkerLoop({
      intervalMs: 2_000,
      run,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const first = loop.runNow();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    await expect(loop.runNow()).resolves.toBe(false);
    expect(timer.callbacks).toHaveLength(0);

    release?.();
    await expect(first).resolves.toBe(true);
    expect(timer.delays).toEqual([2_000]);
    await loop.stop();
  });

  it("contains task failures and reports them through the error hook", async () => {
    const timer = fakeTimer();
    const onError = vi.fn();
    const failure = new Error("worker exploded");
    const loop = new NonOverlappingWorkerLoop({
      intervalMs: 1_000,
      run: async () => {
        throw failure;
      },
      onError,
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    await expect(loop.runNow()).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(failure);
    expect(timer.callbacks).toHaveLength(1);
    await loop.stop();
  });

  it("stop waits for in-flight work and prevents another scheduled run", async () => {
    const timer = fakeTimer();
    let release: (() => void) | undefined;
    const loop = new NonOverlappingWorkerLoop({
      intervalMs: 1_000,
      run: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      setTimer: timer.setTimer,
      clearTimer: timer.clearTimer,
    });

    const running = loop.runNow();
    await Promise.resolve();
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release?.();
    await running;
    await stopping;
    expect(timer.callbacks).toHaveLength(0);
    await expect(loop.runNow()).resolves.toBe(false);
  });
});
