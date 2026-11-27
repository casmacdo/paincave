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
    window.sessionStorage.clear();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    window.sessionStorage.clear();
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
    expect(client.getSnapshot().liveHistory).toHaveLength(1);

    // Simulate disconnect and verify backoff reconnect
    sockets[0]?.close();
    expect(client.getSnapshot().connected).toBe(false);
    vi.advanceTimersByTime(600);
    expect(sockets).toHaveLength(2);
    client.disconnect();
  });

  it("persists loaded workout/route/history across page reloads, hydrates from session_state, and queues offline loads", () => {
    const url = "ws://127.0.0.1:8765/ws";
    const client1 = new BridgeClient(url);

    // Send load_workout while disconnected -> queued and persisted optimistically
    const sentImmediately = client1.send({
      type: "load_workout",
      name: "Threshold 2x12",
      ftp_watts: 260,
      steps: [
        {
          step_index: 0,
          label: "Work",
          start_offset_s: 0,
          duration_s: 720,
          mode: "erg",
          watts_start: 245,
          watts_end: 245,
          grade_pct: null,
          resistance_pct: null,
          cadence_rpm: 90,
          text_cue: null,
          is_work_interval: true,
        },
      ],
      route: null,
    });
    expect(sentImmediately).toBe(false);
    expect(client1.getSnapshot().loadedWorkoutName).toBe("Threshold 2x12");
    expect(client1.getSnapshot().loadedSteps).toHaveLength(1);

    // New client instance (simulating page reload) restores loaded workout immediately
    const client2 = new BridgeClient(url);
    expect(client2.getSnapshot().loadedWorkoutName).toBe("Threshold 2x12");
    expect(client2.getSnapshot().loadedSteps).toHaveLength(1);

    // Authoritative session_state from bridge updates steps/route/history and clears on discard
    client2.connect();
    sockets[0]?.triggerOpen();
    sockets[0]?.triggerMessage({
      type: "session_state",
      workout_name: "Montreal Route (SIM)",
      steps: [],
      route: {
        name: "Montreal Route",
        points: [
          { lat_deg: 45.5, lon_deg: -73.6, elevation_m: 30 },
          { lat_deg: 45.51, lon_deg: -73.6, elevation_m: 80 },
        ],
        loop_route: true,
        sim_mode: true,
        trainer_difficulty_pct: 100,
      },
      history: [{ t_s: 1, watts: 210, target_watts: null, hr_bpm: 140 }],
    });
    expect(client2.getSnapshot().loadedWorkoutName).toBe("Montreal Route (SIM)");
    expect(client2.getSnapshot().loadedRoute?.name).toBe("Montreal Route");
    expect(client2.getSnapshot().liveHistory).toHaveLength(1);

    client2.send({ type: "discard" });
    expect(client2.getSnapshot().loadedWorkoutName).toBeNull();
    expect(client2.getSnapshot().loadedRoute).toBeNull();
    expect(client2.getSnapshot().liveHistory).toEqual([]);
    client2.disconnect();
  });
});
