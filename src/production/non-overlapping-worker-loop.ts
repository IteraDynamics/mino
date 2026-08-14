export interface NonOverlappingWorkerLoopOptions {
  readonly intervalMs: number;
  readonly run: () => Promise<void>;
  readonly onError?: (error: unknown) => void;
  readonly setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
}

/**
 * Schedules background work without overlap. The next timer is armed only after the
 * prior run settles, so slow work cannot create an unbounded pile of concurrent runs.
 */
export class NonOverlappingWorkerLoop {
  private readonly intervalMs: number;
  private readonly run: () => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private readonly setTimer: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private stopped = false;

  public constructor(options: NonOverlappingWorkerLoopOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("Worker loop interval must be a positive integer");
    }
    this.intervalMs = options.intervalMs;
    this.run = options.run;
    this.onError = options.onError ?? (() => undefined);
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  public start(runImmediately = true): void {
    if (this.started && !this.stopped) {
      return;
    }
    this.started = true;
    this.stopped = false;
    if (runImmediately) {
      void this.runNow();
    } else {
      this.armTimer();
    }
  }

  public async runNow(): Promise<boolean> {
    if (this.stopped || this.inFlight) {
      return false;
    }

    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }

    const operation = (async () => {
      try {
        await this.run();
      } catch (error) {
        this.onError(error);
      } finally {
        this.inFlight = undefined;
        if (!this.stopped) {
          this.armTimer();
        }
      }
    })();
    this.inFlight = operation;
    await operation;
    return true;
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  private armTimer(): void {
    if (this.stopped || this.timer) {
      return;
    }
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.runNow();
    }, this.intervalMs);
    this.timer.unref?.();
  }
}
