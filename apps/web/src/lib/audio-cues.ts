export type CueToneKind = "countdown" | "transition";

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (typeof Ctor !== "function") return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new Ctor();
  }
  if (sharedAudioCtx.state === "suspended") {
    void sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/**
 * Plays a short, non-intrusive Web Audio tone for 3-2-1 interval countdowns
 * and step transitions. Silently no-ops in headless/test environments.
 */
export function playIntervalCueTone(kind: CueToneKind): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "transition" ? "triangle" : "sine";
    osc.frequency.setValueAtTime(kind === "transition" ? 880 : 660, now);

    const duration = kind === "transition" ? 0.22 : 0.11;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.01);
  } catch {
    // Ignore audio policy errors when tab has not yet received a user gesture
  }
}
