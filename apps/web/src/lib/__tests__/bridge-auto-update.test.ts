import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { VersionAutoReloader } from "../auto-update.js";
import { BridgeClient } from "../bridge-client.js";

describe("VersionAutoReloader", () => {
  it("never triggers reload during an active workout and reloads once idle", async () => {
    let serverSha = "sha-v1";
    let workoutState: "idle" | "running" | "paused" = "running";
    const onReload = vi.fn();

    const reloader = new VersionAutoReloader({
      fetchVersion: () => Promise.resolve({ build_sha: serverSha }),
      getWorkoutState: () => workoutState,
      onUpdateDetected: onReload,
    });

    // Initial check establishes baseline
    await reloader.checkOnce();
    expect(onReload).not.toHaveBeenCalled();

    // Deploy happens while workout is running or paused -> must NOT reload
    serverSha = "sha-v2";
    await reloader.checkOnce();
    expect(onReload).not.toHaveBeenCalled();

    workoutState = "paused";
    await reloader.checkOnce();
    expect(onReload).not.toHaveBeenCalled();

    // Workout finishes and returns to idle -> reloads cleanly
    workoutState = "idle";
    await reloader.checkOnce();
    expect(onReload).toHaveBeenCalledWith("sha-v2");
  });
});

describe("BridgeClient", () => {
  let sockets: MockWebSocket[] = [];

  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(public readonly url: string) {
      sockets.push(this);
    }

    send(data: string): void {
      this.sent.push(data);
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.();
    }

    triggerOpen(): void {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }

    triggerMessage(payload: unknown): void {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  }

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects, sends commands, updates telemetry, and schedules reconnect on close", () => {
    const client = new BridgeClient("ws://127.0.0.1:8765/ws");
    client.connect();
    expect(sockets).toHaveLength(1);

    sockets[0]?.triggerOpen();
    expect(client.getSnapshot().connected).toBe(true);

    client.send({ type: "start" });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ type: "start" }));

    sockets[0]?.triggerMessage({
      type: "telemetry",
      ts_ms: 1000,
      ride_uuid: "u-1",
      workout_name: "Sweet Spot",
      state: "running",
      elapsed_s: 42,
      step_index: 0,
      total_steps: 2,
      step_label: "Warmup",
      step_elapsed_s: 42,
      step_remaining_s: 18,
      mode: "erg",
      target_watts: 180,
      target_grade_pct: null,
      erg_bias_pct: 100,
      watts: 179,
      watts_3s: 180,
      cadence_rpm: 90,
      hr_bpm: 138,
      speed_kph: 30.2,
      text_cue: "Smooth spin",
      sensors: { trainer: "connected", hr: "connected", transport: "mock" },
      pending_uploads: 0,
    });
    expect(client.getSnapshot().telemetry?.watts_3s).toBe(180);

    // Simulate disconnect and verify backoff reconnect
    sockets[0]?.close();
    expect(client.getSnapshot().connected).toBe(false);
    vi.advanceTimersByTime(600);
    expect(sockets).toHaveLength(2);
    client.disconnect();
  });
});
