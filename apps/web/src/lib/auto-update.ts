import type { BridgeEvent } from "@paincave/shared";

type WorkoutState = Extract<BridgeEvent, { type: "telemetry" }>["state"];

export interface AutoUpdateOptions {
  fetchVersion: () => Promise<{ build_sha: string }>;
  getWorkoutState: () => WorkoutState;
  onUpdateDetected: (newSha: string) => void;
  intervalMs?: number;
}

export class VersionAutoReloader {
  private baselineSha: string | null = null;
  private pendingSha: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: AutoUpdateOptions;

  constructor(opts: AutoUpdateOptions) {
    this.opts = opts;
  }

  async checkOnce(): Promise<boolean> {
    try {
      const { build_sha } = await this.opts.fetchVersion();
      if (this.baselineSha === null) {
        this.baselineSha = build_sha;
        return false;
      }
      if (build_sha !== this.baselineSha) {
        this.pendingSha = build_sha;
      }
      if (this.pendingSha !== null && this.opts.getWorkoutState() === "idle") {
        const nextSha = this.pendingSha;
        this.pendingSha = null;
        this.baselineSha = nextSha;
        this.opts.onUpdateDetected(nextSha);
        return true;
      }
    } catch {
      // Offline / network glitch — ignore until next poll
    }
    return false;
  }

  start(): void {
    void this.checkOnce();
    this.timer = setInterval(() => {
      void this.checkOnce();
    }, this.opts.intervalMs ?? 5 * 60 * 1000);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
