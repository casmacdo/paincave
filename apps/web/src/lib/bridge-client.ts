import type {
  BridgeCommand,
  BridgeEvent,
  FlattenedStep,
  LiveHistoryPoint,
  RoutePayload,
} from "@paincave/shared";

export type TelemetryEvent = Extract<BridgeEvent, { type: "telemetry" }>;
export type RideSavedEvent = Extract<BridgeEvent, { type: "ride_saved" }>;

export interface BridgeClientSnapshot {
  connected: boolean;
  telemetry: TelemetryEvent | null;
  lastSaved: RideSavedEvent | null;
  lastError: string | null;
  loadedWorkoutName?: string | null;
  loadedSteps: FlattenedStep[];
  loadedRoute?: RoutePayload | null;
  liveHistory?: LiveHistoryPoint[];
}

export type BridgeListener = (snapshot: BridgeClientSnapshot) => void;

export const DEFAULT_BRIDGE_WS_URL = "ws://127.0.0.1:8765/ws";
const SESSION_STORAGE_PREFIX = "paincave_bridge_session_v1:";
const MAX_HISTORY_POINTS = 7200;

interface PersistedBridgeSession {
  loadedWorkoutName: string | null;
  loadedSteps: FlattenedStep[];
  loadedRoute: RoutePayload | null;
  liveHistory: LiveHistoryPoint[];
}

function readPersistedSession(url: string): PersistedBridgeSession | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(`${SESSION_STORAGE_PREFIX}${url}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedBridgeSession>;
    return {
      loadedWorkoutName: typeof parsed.loadedWorkoutName === "string" ? parsed.loadedWorkoutName : null,
      loadedSteps: Array.isArray(parsed.loadedSteps) ? parsed.loadedSteps : [],
      loadedRoute: parsed.loadedRoute ?? null,
      liveHistory: Array.isArray(parsed.liveHistory) ? parsed.liveHistory.slice(-MAX_HISTORY_POINTS) : [],
    };
  } catch {
    return null;
  }
}

function writePersistedSession(url: string, snapshot: BridgeClientSnapshot): void {
  if (typeof window === "undefined") return;
  try {
    const hasSession =
      Boolean(snapshot.loadedWorkoutName) ||
      snapshot.loadedSteps.length > 0 ||
      Boolean(snapshot.loadedRoute) ||
      (snapshot.liveHistory?.length ?? 0) > 0;
    const key = `${SESSION_STORAGE_PREFIX}${url}`;
    if (!hasSession) {
      window.sessionStorage.removeItem(key);
      return;
    }
    const payload: PersistedBridgeSession = {
      loadedWorkoutName: snapshot.loadedWorkoutName ?? null,
      loadedSteps: snapshot.loadedSteps,
      loadedRoute: snapshot.loadedRoute ?? null,
      liveHistory: (snapshot.liveHistory ?? []).slice(-MAX_HISTORY_POINTS),
    };
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private listeners = new Set<BridgeListener>();
  private pendingCommands: BridgeCommand[] = [];
  private sawNonIdleState = false;
  private localLoadAtMs = 0;

  private snapshot: BridgeClientSnapshot;

  constructor(url = DEFAULT_BRIDGE_WS_URL) {
    this.url = url;
    const persisted = readPersistedSession(url);
    this.snapshot = {
      connected: false,
      telemetry: null,
      lastSaved: null,
      lastError: null,
      loadedWorkoutName: persisted?.loadedWorkoutName ?? null,
      loadedSteps: persisted?.loadedSteps ?? [],
      loadedRoute: persisted?.loadedRoute ?? null,
      liveHistory: persisted?.liveHistory ?? [],
    };
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
      if (this.pendingCommands.length > 0 && socket.readyState === WebSocket.OPEN) {
        for (const cmd of this.pendingCommands.splice(0)) {
          socket.send(JSON.stringify(cmd));
        }
      }
    };

    socket.onmessage = (msg) => {
      try {
        const event = JSON.parse(String(msg.data)) as BridgeEvent;
        if (event.type === "session_state") {
          const isRemoteIdle =
            event.workout_name === null && event.steps.length === 0 && !event.route;
          if (!isRemoteIdle || this.pendingCommands.length === 0) {
            this.snapshot = {
              ...this.snapshot,
              loadedWorkoutName: event.workout_name,
              loadedSteps: event.steps,
              loadedRoute: event.route ?? null,
              liveHistory: event.history.slice(-MAX_HISTORY_POINTS),
            };
            writePersistedSession(this.url, this.snapshot);
          }
        } else if (event.type === "telemetry") {
          if (event.state !== "idle") {
            this.sawNonIdleState = true;
            this.localLoadAtMs = 0;
          }

          if (event.state === "idle") {
            const shouldClearLoaded =
              this.pendingCommands.length === 0 &&
              (this.sawNonIdleState || Date.now() - this.localLoadAtMs > 2500);
            if (shouldClearLoaded) {
              this.sawNonIdleState = false;
              this.snapshot = {
                ...this.snapshot,
                telemetry: event,
                loadedWorkoutName: null,
                loadedSteps: [],
                loadedRoute: null,
                liveHistory: [],
              };
              writePersistedSession(this.url, this.snapshot);
            } else {
              this.snapshot = { ...this.snapshot, telemetry: event };
            }
          } else if (event.state === "running" || event.state === "auto_paused") {
            const prevHistory = this.snapshot.liveHistory ?? [];
            const last = prevHistory.at(-1);
            const nextHistory =
              last && last.t_s === event.elapsed_s
                ? prevHistory
                : [
                    ...prevHistory,
                    {
                      t_s: event.elapsed_s,
                      watts: event.watts,
                      target_watts: event.target_watts,
                      hr_bpm: event.hr_bpm,
                    },
                  ].slice(-MAX_HISTORY_POINTS);
            this.snapshot = {
              ...this.snapshot,
              telemetry: event,
              loadedWorkoutName: event.workout_name ?? this.snapshot.loadedWorkoutName ?? null,
              liveHistory: nextHistory,
            };
            writePersistedSession(this.url, this.snapshot);
          } else {
            this.snapshot = {
              ...this.snapshot,
              telemetry: event,
              loadedWorkoutName: event.workout_name ?? this.snapshot.loadedWorkoutName ?? null,
            };
          }
        } else if (event.type === "ride_saved") {
          this.sawNonIdleState = false;
          this.snapshot = {
            ...this.snapshot,
            lastSaved: event,
            loadedWorkoutName: null,
            loadedSteps: [],
            loadedRoute: null,
            liveHistory: [],
          };
          writePersistedSession(this.url, this.snapshot);
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
      this.localLoadAtMs = Date.now();
      this.sawNonIdleState = false;
      this.snapshot = {
        ...this.snapshot,
        loadedWorkoutName: cmd.name,
        loadedSteps: cmd.steps,
        loadedRoute: cmd.route ?? null,
        liveHistory: [],
        lastSaved: null,
      };
      writePersistedSession(this.url, this.snapshot);
      this.emit();
    } else if (cmd.type === "load_route") {
      this.localLoadAtMs = Date.now();
      this.sawNonIdleState = false;
      this.snapshot = {
        ...this.snapshot,
        loadedWorkoutName: cmd.name,
        loadedSteps: [],
        loadedRoute: cmd.route,
        liveHistory: [],
        lastSaved: null,
      };
      writePersistedSession(this.url, this.snapshot);
      this.emit();
    } else if (cmd.type === "discard") {
      this.sawNonIdleState = false;
      this.pendingCommands = [];
      this.snapshot = {
        ...this.snapshot,
        loadedWorkoutName: null,
        loadedSteps: [],
        loadedRoute: null,
        liveHistory: [],
      };
      writePersistedSession(this.url, this.snapshot);
      this.emit();
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (cmd.type === "load_workout" || cmd.type === "load_route") {
        this.pendingCommands = [
          ...this.pendingCommands.filter(
            (c) => c.type !== "load_workout" && c.type !== "load_route"
          ),
          cmd,
        ];
      }
      return false;
    }
    this.ws.send(JSON.stringify(cmd));
    return true;
  }
}
