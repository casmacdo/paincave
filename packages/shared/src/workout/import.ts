import {
  WORKOUT_CATEGORIES,
  WorkoutSpecSchema,
  type AtomicStep,
  type WorkoutCategory,
  type WorkoutSpec,
  type WorkoutStep,
} from "./schema.js";

function unescapeXml(text: string): string {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function parseAttributes(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([A-Za-z_][A-Za-z0-9_:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(attrText)) !== null) {
    const key = match[1]?.toLowerCase();
    const val = match[2] ?? match[3] ?? "";
    if (key) {
      attrs[key] = unescapeXml(val.trim());
    }
  }
  return attrs;
}

function extractTagContent(xml: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = re.exec(xml);
  if (!match || match[1] === undefined) return null;
  return unescapeXml(match[1].trim());
}

function clampFtp(val: number): number {
  return Number(Math.min(2.5, Math.max(0.25, val)).toFixed(3));
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function parseCadence(raw: string | undefined): number | undefined {
  const n = parsePositiveInt(raw);
  if (n === null || n < 40 || n > 140) return undefined;
  return n;
}

function matchCategory(raw: string | undefined): WorkoutCategory | null {
  if (!raw) return null;
  const normalized = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((WORKOUT_CATEGORIES as readonly string[]).includes(normalized)) {
    return normalized as WorkoutCategory;
  }
  if (normalized === "sweetspot") return "sweet_spot";
  if (normalized === "vo2" || normalized === "vo2_max") return "vo2max";
  return null;
}

function inferCategoryFromSteps(steps: readonly WorkoutStep[]): WorkoutCategory {
  let maxSustainedFtp = 0;
  let maxShortFtp = 0;

  const inspect = (s: AtomicStep) => {
    if (s.type === "steady" && s.target_ftp !== undefined) {
      if (s.duration_s >= 180) maxSustainedFtp = Math.max(maxSustainedFtp, s.target_ftp);
      else maxShortFtp = Math.max(maxShortFtp, s.target_ftp);
    } else if (s.type === "ramp" && s.start_ftp !== undefined && s.end_ftp !== undefined) {
      const avg = (s.start_ftp + s.end_ftp) / 2;
      if (s.duration_s >= 180) maxSustainedFtp = Math.max(maxSustainedFtp, avg);
      else maxShortFtp = Math.max(maxShortFtp, avg);
    }
  };

  for (const step of steps) {
    if (step.type === "repeat") {
      for (const inner of step.steps) inspect(inner);
    } else {
      inspect(step);
    }
  }

  if (maxShortFtp >= 1.45) return "sprint";
  if (maxShortFtp >= 1.2) return "anaerobic";
  if (maxSustainedFtp >= 1.06) return "vo2max";
  if (maxSustainedFtp >= 0.95) return "threshold";
  if (maxSustainedFtp >= 0.87) return "sweet_spot";
  if (maxSustainedFtp >= 0.76) return "tempo";
  if (maxSustainedFtp >= 0.56) return "endurance";
  if (maxSustainedFtp > 0) return "recovery";
  return "custom";
}

function stripExtension(filename: string): string {
  return filename.replace(/\.(zwo|erg|mrc)$/i, "").replace(/[_-]+/g, " ").trim();
}

/**
 * Parses a Zwift/GoldenCheetah `.zwo` XML file into a canonical validated `WorkoutSpec`.
 */
export function importZwoXml(xmlText: string, fallbackName = "Imported Workout"): WorkoutSpec {
  const workoutBody = extractTagContent(xmlText, "workout");
  if (!workoutBody) {
    throw new Error("Invalid .zwo file: missing <workout> element");
  }

  const name = (extractTagContent(xmlText, "name") || stripExtension(fallbackName) || "Imported Workout").slice(0, 120);
  const description = (extractTagContent(xmlText, "description") || "").slice(0, 1000);

  let category: WorkoutCategory | null = null;
  const tagRe = /<tag\b([^>]*)\/?>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(xmlText)) !== null) {
    const attrs = parseAttributes(tagMatch[1] ?? "");
    const matched = matchCategory(attrs["name"]);
    if (matched) {
      category = matched;
      break;
    }
  }

  const steps: WorkoutStep[] = [];
  const stepRe =
    /<(SteadyState|Warmup|Cooldown|Ramp|IntervalsT|FreeRide)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  let match: RegExpExecArray | null;
  while ((match = stepRe.exec(workoutBody)) !== null) {
    const rawTag = (match[1] ?? "").toLowerCase();
    const attrs = parseAttributes(match[2] ?? "");
    const innerXml = match[3] ?? "";

    let textCue: string | undefined;
    const textEventMatch = /<textevent\b([^>]*)\/?>/i.exec(innerXml);
    if (textEventMatch) {
      const msg = parseAttributes(textEventMatch[1] ?? "")["message"];
      if (msg) textCue = msg.slice(0, 200);
    }

    if (rawTag === "steadystate") {
      const durationS = parsePositiveInt(attrs["duration"]);
      const power = Number(attrs["power"]);
      if (!durationS || !Number.isFinite(power) || power <= 0) continue;
      steps.push({
        type: "steady",
        duration_s: Math.min(14400, Math.max(5, durationS)),
        target_ftp: clampFtp(power),
        cadence_rpm: parseCadence(attrs["cadence"]),
        text_cue: textCue,
      });
    } else if (rawTag === "warmup" || rawTag === "cooldown" || rawTag === "ramp") {
      const durationS = parsePositiveInt(attrs["duration"]);
      const pLow = Number(attrs["powerlow"]);
      const pHigh = Number(attrs["powerhigh"]);
      if (!durationS || !Number.isFinite(pLow) || !Number.isFinite(pHigh)) continue;
      const startFtp = clampFtp(pLow);
      const endFtp = clampFtp(pHigh);
      const clampedDur = Math.min(7200, Math.max(10, durationS));
      if (Math.abs(startFtp - endFtp) < 0.001) {
        steps.push({
          type: "steady",
          duration_s: clampedDur,
          target_ftp: startFtp,
          label: rawTag === "warmup" ? "Warmup" : rawTag === "cooldown" ? "Cooldown" : undefined,
          cadence_rpm: parseCadence(attrs["cadence"]),
          text_cue: textCue,
        });
      } else {
        steps.push({
          type: "ramp",
          duration_s: clampedDur,
          start_ftp: startFtp,
          end_ftp: endFtp,
          label: rawTag === "warmup" ? "Warmup" : rawTag === "cooldown" ? "Cooldown" : "Ramp",
          cadence_rpm: parseCadence(attrs["cadence"]),
          text_cue: textCue,
        });
      }
    } else if (rawTag === "intervalst") {
      const repeat = parsePositiveInt(attrs["repeat"]);
      const onDur = parsePositiveInt(attrs["onduration"]);
      const offDur = parsePositiveInt(attrs["offduration"]);
      const onPower = Number(attrs["onpower"]);
      const offPower = Number(attrs["offpower"]);
      if (!repeat || !onDur || !Number.isFinite(onPower)) continue;
      const blockSteps: AtomicStep[] = [
        {
          type: "steady",
          duration_s: Math.min(14400, Math.max(5, onDur)),
          target_ftp: clampFtp(onPower),
          label: "Work",
          cadence_rpm: parseCadence(attrs["cadence"]),
          text_cue: textCue,
        },
      ];
      if (offDur && Number.isFinite(offPower) && offPower > 0) {
        blockSteps.push({
          type: "steady",
          duration_s: Math.min(14400, Math.max(5, offDur)),
          target_ftp: clampFtp(offPower),
          label: "Recovery",
          cadence_rpm: parseCadence(attrs["cadenceresting"]),
        });
      }
      if (repeat >= 2) {
        steps.push({
          type: "repeat",
          count: Math.min(50, repeat),
          steps: blockSteps,
        });
      } else {
        steps.push(...blockSteps);
      }
    } else if (rawTag === "freeride") {
      const durationS = parsePositiveInt(attrs["duration"]);
      if (!durationS) continue;
      steps.push({
        type: "free_ride",
        duration_s: Math.min(14400, Math.max(5, durationS)),
        label: "Free Ride",
        cadence_rpm: parseCadence(attrs["cadence"]),
        text_cue: textCue,
      });
    }
  }

  if (steps.length === 0) {
    throw new Error("No valid workout intervals found in .zwo file");
  }

  return WorkoutSpecSchema.parse({
    schema_version: 1,
    name,
    description,
    category: category ?? inferCategoryFromSteps(steps),
    steps: steps.slice(0, 100),
  });
}

/**
 * Parses a `.erg` (MINUTES WATTS) or `.mrc` (MINUTES PERCENT) workout file into a canonical `WorkoutSpec`.
 */
export function importErgOrMrcText(
  text: string,
  options: {
    fallbackName?: string;
    fallbackFtpWatts?: number;
    formatHint?: "erg" | "mrc";
  } = {}
): WorkoutSpec {
  const lines = text.split(/\r?\n/);
  let inHeader = false;
  let inData = false;
  let isPercent = options.formatHint === "mrc";
  let headerFtp = options.fallbackFtpWatts ?? 250;
  let headerDescription = "";
  let headerFileName = "";
  const points: { min: number; value: number }[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "[COURSE HEADER]") {
      inHeader = true;
      inData = false;
      continue;
    }
    if (upper === "[END COURSE HEADER]") {
      inHeader = false;
      continue;
    }
    if (upper === "[COURSE DATA]") {
      inData = true;
      inHeader = false;
      continue;
    }
    if (upper === "[END COURSE DATA]") {
      inData = false;
      continue;
    }

    if (inHeader) {
      if (upper.includes("MINUTES") && upper.includes("PERCENT")) {
        isPercent = true;
      } else if (upper.includes("MINUTES") && upper.includes("WATTS")) {
        isPercent = false;
      } else if (upper.startsWith("FTP")) {
        const val = Number(line.split("=")[1]?.trim());
        if (Number.isFinite(val) && val >= 50 && val <= 600) {
          headerFtp = val;
        }
      } else if (upper.startsWith("DESCRIPTION")) {
        headerDescription = (line.split("=").slice(1).join("=") || "").trim();
      } else if (upper.startsWith("FILE NAME")) {
        headerFileName = (line.split("=").slice(1).join("=") || "").trim();
      }
      continue;
    }

    if (inData) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const min = Number(parts[0]);
      const val = Number(parts[1]);
      if (Number.isFinite(min) && Number.isFinite(val) && min >= 0 && val >= 0) {
        points.push({ min, value: val });
      }
    }
  }

  if (points.length < 2) {
    throw new Error("No valid [COURSE DATA] points found in .erg/.mrc file");
  }

  const toFtpRatio = (raw: number) => clampFtp(isPercent ? raw / 100 : raw / Math.max(50, headerFtp));
  const steps: WorkoutStep[] = [];

  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const durS = Math.round((b.min - a.min) * 60);
    if (durS < 5) continue;

    const startFtp = toFtpRatio(a.value);
    const endFtp = toFtpRatio(b.value);

    if (Math.abs(startFtp - endFtp) < 0.005) {
      const prev = steps.at(-1);
      if (
        prev &&
        prev.type === "steady" &&
        prev.target_ftp !== undefined &&
        Math.abs(prev.target_ftp - startFtp) < 0.005 &&
        prev.duration_s + durS <= 14400
      ) {
        prev.duration_s += durS;
      } else {
        steps.push({
          type: "steady",
          duration_s: Math.min(14400, durS),
          target_ftp: startFtp,
        });
      }
    } else {
      steps.push({
        type: "ramp",
        duration_s: Math.min(7200, Math.max(10, durS)),
        start_ftp: startFtp,
        end_ftp: endFtp,
      });
    }
  }

  if (steps.length === 0) {
    throw new Error("Could not extract any valid intervals from .erg/.mrc data");
  }

  const resolvedName = (
    stripExtension(options.fallbackName || "") ||
    stripExtension(headerFileName) ||
    headerDescription ||
    "Imported Workout"
  ).slice(0, 120);

  return WorkoutSpecSchema.parse({
    schema_version: 1,
    name: resolvedName,
    description: headerDescription.slice(0, 1000),
    category: inferCategoryFromSteps(steps),
    steps: steps.slice(0, 100),
  });
}

/**
 * Auto-detects and parses `.zwo`, `.erg`, or `.mrc` workout files.
 */
export function importWorkoutFile(
  filename: string,
  text: string,
  fallbackFtpWatts = 250
): WorkoutSpec {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".zwo") || text.trimStart().startsWith("<")) {
    return importZwoXml(text, filename);
  }
  if (lower.endsWith(".mrc")) {
    return importErgOrMrcText(text, {
      fallbackName: filename,
      fallbackFtpWatts,
      formatHint: "mrc",
    });
  }
  return importErgOrMrcText(text, {
    fallbackName: filename,
    fallbackFtpWatts,
    formatHint: "erg",
  });
}
