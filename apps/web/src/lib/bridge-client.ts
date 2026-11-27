import type { BridgeCommand, BridgeEvent, FlattenedStep, RoutePayload } from "@paincave/shared";

export type TelemetryEvent = Extract<BridgeEvent, { type: "telemetry" }>;
export type RideSavedEvent = Extract<BridgeEvent, { type: "ride_saved" }>;

export interface BridgeClientSnapshot {
  connected: boolean;
  telemetry: TelemetryEvent | null;
  lastSaved: RideSavedEvent | null;
  lastError: string | null;
  loadedSteps: FlattenedStep[];
  loadedRoute?: RoutePayload | null;
}

export type BridgeListener = (snapshot: BridgeClientSnapshot) => void;

export const DEFAULT_BRIDGE_WS_URL = "ws://127.0.0.1:8765/ws";

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private listeners = new Set<BridgeListener>();

  private snapshot: BridgeClientSnapshot = {
    connected: false,
    telemetry: null,
    lastSaved: null,
    lastError: null,
    loadedSteps: [],
    loadedRoute: null,
  };

  constructor(url = DEFAULT_BRIDGE_WS_URL) {
    this.url = url;
  }

  getSnapshot(): BridgeClientSnapshot {
    return this.snapshot;
  }

  subscribe(listener: BridgeListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const fn of this.listeners) {
      fn(this.snapshot);
    }
  }

  setUrl(nextUrl: string): void {
    if (nextUrl === this.url) return;
    this.url = nextUrl;
    if (!this.stopped) {
      this.disconnect();
      this.stopped = false;
      this.connect();
    }
  }

  connect(): void {
    this.stopped = false;
    if (typeof WebSocket === "undefined") return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const socket = new WebSocket(this.url);
    this.ws = socket;

    socket.onopen = () => {
      this.reconnectAttempt = 0;
      this.snapshot = { ...this.snapshot, connected: true, lastError: null };
      this.emit();
    };

    socket.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as BridgeEvent;
        if (event.type === "telemetry") {
          this.snapshot = { ...this.snapshot, telemetry: event };
        } else if (event.type === "ride_saved") {
          this.snapshot = { ...this.snapshot, lastSaved: event, loadedSteps: [], loadedRoute: null };
        } else if (event.type === "error") {
          this.snapshot = { ...this.snapshot, lastError: `${event.code}: ${event.message}` };
        }
        this.emit();
      } catch {
        // Ignore malformed messages
      }
    };

    socket.onclose = () => {
      this.ws = null;
      this.snapshot = { ...this.snapshot, connected: false };
      this.emit();
      if (!this.stopped) {
        const delayMs = Math.min(10_000, 500 * 2 ** Math.min(4, this.reconnectAttempt));
        this.reconnectAttempt++;
        this.reconnectTimer = setTimeout(() => this.connect(), delayMs);
      }
    };

    socket.onerror = () => {
      this.snapshot = { ...this.snapshot, lastError: "Bridge connection error" };
      this.emit();
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(cmd: BridgeCommand): boolean {
    if (cmd.type === "load_workout") {
      this.snapshot = {
        ...this.snapshot,
        loadedSteps: cmd.steps,
        loadedRoute: cmd.route ?? null,
        lastSaved: null,
      };
      this.emit();
    } else if (cmd.type === "load_route") {
      this.snapshot = {
        ...this.snapshot,
        loadedSteps: [],
        loadedRoute: cmd.route,
        lastSaved: null,
      };
      this.emit();
    } else if (cmd.type === "discard") {
      this.snapshot = { ...this.snapshot, loadedSteps: [], loadedRoute: null };
      this.emit();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify(cmd));
    return true;
  }
}
