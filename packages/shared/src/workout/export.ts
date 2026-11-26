import { flattenWorkout } from "./flatten.js";
import type { WorkoutSpec } from "./schema.js";

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function fmtFtp(watts: number, ftpWatts: number): string {
  return (watts / ftpWatts).toFixed(3);
}

/**
 * Deterministic compiler from canonical WorkoutSpec JSON to Zwift/GoldenCheetah .zwo XML.
 */
export function toZwoXml(spec: WorkoutSpec, ftpWatts: number): string {
  const flattened = flattenWorkout(spec, ftpWatts);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<workout_file>",
    "  <author>PainCave</author>",
    `  <name>${escapeXml(spec.name)}</name>`,
    `  <description>${escapeXml(spec.description)}</description>`,
    "  <sportType>bike</sportType>",
    `  <tags><tag name="${escapeXml(spec.category)}"/></tags>`,
    "  <workout>",
  ];

  for (const step of flattened) {
    const cadenceAttr = step.cadence_rpm !== null ? ` Cadence="${step.cadence_rpm}"` : "";
    const textChild =
      step.text_cue !== null
        ? `\n      <textevent timeoffset="0" message="${escapeXml(step.text_cue)}"/>\n    `
        : "";

    if (step.mode === "erg" && step.watts_start !== null && step.watts_end !== null) {
      if (step.watts_start === step.watts_end) {
        const power = fmtFtp(step.watts_start, ftpWatts);
        if (textChild) {
          lines.push(
            `    <SteadyState Duration="${step.duration_s}" Power="${power}"${cadenceAttr}>${textChild}</SteadyState>`
          );
        } else {
          lines.push(`    <SteadyState Duration="${step.duration_s}" Power="${power}"${cadenceAttr}/>`);
        }
      } else {
        const tag = step.watts_end > step.watts_start ? "Warmup" : "Cooldown";
        const pLow = fmtFtp(step.watts_start, ftpWatts);
        const pHigh = fmtFtp(step.watts_end, ftpWatts);
        if (textChild) {
          lines.push(
            `    <${tag} Duration="${step.duration_s}" PowerLow="${pLow}" PowerHigh="${pHigh}"${cadenceAttr}>${textChild}</${tag}>`
          );
        } else {
          lines.push(
            `    <${tag} Duration="${step.duration_s}" PowerLow="${pLow}" PowerHigh="${pHigh}"${cadenceAttr}/>`
          );
        }
      }
    } else {
      const flatRoad = step.mode === "slope" ? "0" : "1";
      if (textChild) {
        lines.push(
          `    <FreeRide Duration="${step.duration_s}" FlatRoad="${flatRoad}"${cadenceAttr}>${textChild}</FreeRide>`
        );
      } else {
        lines.push(`    <FreeRide Duration="${step.duration_s}" FlatRoad="${flatRoad}"${cadenceAttr}/>`);
      }
    }
  }

  lines.push("  </workout>", "</workout_file>", "");
  return lines.join("\n");
}

/**
 * Deterministic compiler from canonical WorkoutSpec JSON to GoldenCheetah-compatible .erg format.
 */
export function toErgText(spec: WorkoutSpec, ftpWatts: number): string {
  const flattened = flattenWorkout(spec, ftpWatts);
  const safeFileName = spec.name.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60) || "workout";
  const lines: string[] = [
    "[COURSE HEADER]",
    "VERSION = 2",
    "UNITS = ENGLISH",
    `DESCRIPTION = ${spec.description || spec.name}`,
    `FILE NAME = ${safeFileName}.erg`,
    `FTP = ${Math.round(ftpWatts)}`,
    "MINUTES WATTS",
    "[END COURSE HEADER]",
    "[COURSE DATA]",
  ];

  for (const step of flattened) {
    const startMin = (step.start_offset_s / 60).toFixed(3);
    const endMin = ((step.start_offset_s + step.duration_s) / 60).toFixed(3);
    const wStart = step.watts_start ?? Math.round(ftpWatts * 0.75);
    const wEnd = step.watts_end ?? wStart;
    lines.push(`${startMin}\t${wStart}`);
    lines.push(`${endMin}\t${wEnd}`);
  }

  lines.push("[END COURSE DATA]", "");
  return lines.join("\n");
}
