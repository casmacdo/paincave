import {
  DEFAULT_THRESHOLD_PACE_S_PER_KM,
  estimateRunStepPaceSPerKm,
  type RunAtomicStep,
  type RunWorkoutSpec,
} from "../workout/run-schema.js";
import type { AtomicStep, WorkoutSpec } from "../workout/schema.js";
import type { StrengthWorkoutSpec } from "../workout/strength-schema.js";
import { getWorkoutSpecSport, type AnyWorkoutSpec } from "../workout/guardrails.js";

const FIT_EPOCH_UNIX_S = 631065600; // 1989-12-31T00:00:00Z
const FIT_PROTOCOL_VERSION = 0x20;
const FIT_PROFILE_VERSION = 2140;
const STEP_NAME_BYTES = 32;
const WORKOUT_NAME_BYTES = 32;

// FIT SDK enums
export const FIT_FILE_TYPE_WORKOUT = 5;
export const FIT_SPORT_RUNNING = 1;
export const FIT_SPORT_CYCLING = 2;
export const FIT_SPORT_TRAINING = 10;
export const FIT_SUB_SPORT_GENERIC = 0;
export const FIT_SUB_SPORT_STRENGTH_TRAINING = 20;

export const FIT_WKT_STEP_DURATION = {
  time: 0,
  distance: 1,
  open: 5,
  repeat_until_steps_cmplt: 6,
} as const;

export const FIT_WKT_STEP_TARGET = {
  speed: 0,
  heart_rate: 1,
  open: 2,
  power: 4,
} as const;

export const FIT_INTENSITY = {
  active: 0,
  rest: 1,
  warmup: 2,
  cooldown: 3,
  recovery: 4,
} as const;

const CRC_TABLE = [
  0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
] as const;

export function computeFitCrc16(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length
): number {
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = bytes[i] ?? 0;
    let tmp = CRC_TABLE[crc & 0x0f] ?? 0;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (CRC_TABLE[byte & 0x0f] ?? 0);
    tmp = CRC_TABLE[crc & 0x0f] ?? 0;
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ (CRC_TABLE[(byte >> 4) & 0x0f] ?? 0);
  }
  return crc & 0xffff;
}

interface EncodedWorkoutStep {
  messageIndex: number;
  name: string;
  durationType: number;
  durationValue: number;
  targetType: number;
  targetValue: number;
  customTargetLow: number;
  customTargetHigh: number;
  intensity: number;
}

function encodeFixedAscii(text: string, fixedLen: number): Uint8Array {
  const out = new Uint8Array(fixedLen);
  const clean = text.replace(/[^\x20-\x7e]/g, " ").trim();
  const maxChars = Math.max(0, fixedLen - 1);
  for (let i = 0; i < Math.min(clean.length, maxChars); i++) {
    out[i] = clean.charCodeAt(i);
  }
  out[fixedLen - 1] = 0;
  return out;
}

function decodeFixedAscii(bytes: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    const ch = bytes[offset + i] ?? 0;
    if (ch === 0) break;
    out += String.fromCharCode(ch);
  }
  return out;
}

function hashSerialNumber(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) || 1;
}

function pushU16LE(out: number[], value: number): void {
  const v = value & 0xffff;
  out.push(v & 0xff, (v >> 8) & 0xff);
}

function pushU32LE(out: number[], value: number): void {
  const v = value >>> 0;
  out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff);
}

function buildRunStep(
  step: RunAtomicStep,
  messageIndex: number,
  thresholdPaceSPerKm: number
): EncodedWorkoutStep {
  const durationType =
    step.distance_m !== undefined
      ? FIT_WKT_STEP_DURATION.distance
      : FIT_WKT_STEP_DURATION.time;
  const durationValue =
    step.distance_m !== undefined
      ? Math.round(step.distance_m * 100) // cm
      : Math.round((step.duration_s ?? 60) * 1000); // ms

  let targetType: number = FIT_WKT_STEP_TARGET.open;
  let targetValue = 0;
  let customTargetLow = 0;
  let customTargetHigh = 0;

  if (!step.open_target) {
    if (step.pace_range_s_per_km) {
      const fastPace = Math.min(step.pace_range_s_per_km[0], step.pace_range_s_per_km[1]);
      const slowPace = Math.max(step.pace_range_s_per_km[0], step.pace_range_s_per_km[1]);
      targetType = FIT_WKT_STEP_TARGET.speed;
      targetValue = 0;
      // FIT speed target in mm/s (1000 * m/s)
      customTargetLow = Math.max(100, Math.round((1000 / slowPace) * 1000));
      customTargetHigh = Math.max(customTargetLow + 10, Math.round((1000 / fastPace) * 1000));
    } else if (step.pace_zone) {
      const centerPace = estimateRunStepPaceSPerKm(step, thresholdPaceSPerKm);
      const fastPace = centerPace * 0.97;
      const slowPace = centerPace * 1.03;
      targetType = FIT_WKT_STEP_TARGET.speed;
      targetValue = 0;
      customTargetLow = Math.max(100, Math.round((1000 / slowPace) * 1000));
      customTargetHigh = Math.max(customTargetLow + 10, Math.round((1000 / fastPace) * 1000));
    } else if (step.hr_range_bpm) {
      const lowHr = Math.min(step.hr_range_bpm[0], step.hr_range_bpm[1]);
      const highHr = Math.max(step.hr_range_bpm[0], step.hr_range_bpm[1]);
      targetType = FIT_WKT_STEP_TARGET.heart_rate;
      targetValue = 0;
      // FIT custom HR target uses +100 BPM offset
      customTargetLow = Math.round(lowHr + 100);
      customTargetHigh = Math.round(highHr + 100);
    } else if (step.hr_zone) {
      targetType = FIT_WKT_STEP_TARGET.heart_rate;
      targetValue = Number(step.hr_zone.slice(1)) || 2;
      customTargetLow = 0;
      customTargetHigh = 0;
    }
  }

  let intensity: number = FIT_INTENSITY.active;
  if (step.type === "warmup") intensity = FIT_INTENSITY.warmup;
  else if (step.type === "cooldown") intensity = FIT_INTENSITY.cooldown;
  else if (step.type === "recovery") intensity = FIT_INTENSITY.recovery;

  return {
    messageIndex,
    name: step.label ?? step.pace_zone ?? step.type,
    durationType,
    durationValue,
    targetType,
    targetValue,
    customTargetLow,
    customTargetHigh,
    intensity,
  };
}

function buildCyclingStep(
  step: AtomicStep,
  messageIndex: number,
  ftpWatts: number
): EncodedWorkoutStep {
  const durationType = FIT_WKT_STEP_DURATION.time;
  const durationValue = Math.round(step.duration_s * 1000);
  let targetType: number = FIT_WKT_STEP_TARGET.open;
  let customTargetLow = 0;
  let customTargetHigh = 0;
  let intensity: number = FIT_INTENSITY.active;

  if (step.type === "steady") {
    const watts =
      step.target_watts !== undefined
        ? step.target_watts
        : Math.round((step.target_ftp ?? 0.7) * ftpWatts);
    targetType = FIT_WKT_STEP_TARGET.power;
    // FIT custom power target uses +1000W offset
    customTargetLow = Math.max(1000, Math.round(watts - 5) + 1000);
    customTargetHigh = Math.round(watts + 5) + 1000;
    if (watts < ftpWatts * 0.6) intensity = FIT_INTENSITY.recovery;
  } else if (step.type === "ramp") {
    const startW =
      step.start_watts !== undefined
        ? step.start_watts
        : Math.round((step.start_ftp ?? 0.5) * ftpWatts);
    const endW =
      step.end_watts !== undefined
        ? step.end_watts
        : Math.round((step.end_ftp ?? 0.75) * ftpWatts);
    targetType = FIT_WKT_STEP_TARGET.power;
    customTargetLow = Math.max(1000, Math.min(startW, endW) + 1000);
    customTargetHigh = Math.max(startW, endW) + 1000;
    intensity = endW >= startW ? FIT_INTENSITY.warmup : FIT_INTENSITY.cooldown;
  }

  return {
    messageIndex,
    name: step.label ?? step.type,
    durationType,
    durationValue,
    targetType,
    targetValue: 0,
    customTargetLow,
    customTargetHigh,
    intensity,
  };
}

function buildWorkoutSteps(
  spec: AnyWorkoutSpec,
  ftpWatts: number,
  thresholdPaceSPerKm: number
): { sport: number; subSport: number; steps: EncodedWorkoutStep[] } {
  const sportKind = getWorkoutSpecSport(spec);
  const steps: EncodedWorkoutStep[] = [];

  if (sportKind === "running") {
    const runSpec = spec as RunWorkoutSpec;
    for (const step of runSpec.steps) {
      if (step.type === "repeat") {
        const startIndex = steps.length;
        for (const inner of step.steps) {
          steps.push(buildRunStep(inner, steps.length, thresholdPaceSPerKm));
        }
        steps.push({
          messageIndex: steps.length,
          name: step.label ?? `Repeat x${step.count}`,
          durationType: FIT_WKT_STEP_DURATION.repeat_until_steps_cmplt,
          durationValue: startIndex,
          targetType: FIT_WKT_STEP_TARGET.open,
          targetValue: step.count,
          customTargetLow: 0,
          customTargetHigh: 0,
          intensity: FIT_INTENSITY.active,
        });
      } else {
        steps.push(buildRunStep(step, steps.length, thresholdPaceSPerKm));
      }
    }
    return { sport: FIT_SPORT_RUNNING, subSport: FIT_SUB_SPORT_GENERIC, steps };
  }

  if (sportKind === "strength") {
    const strSpec = spec as StrengthWorkoutSpec;
    for (const block of strSpec.blocks) {
      const baseIntensity =
        block.block_type === "warmup" || block.block_type === "mobility"
          ? FIT_INTENSITY.warmup
          : FIT_INTENSITY.active;

      for (const ex of block.exercises) {
        const startIndex = steps.length;
        const repStr = typeof ex.reps === "number" ? `${ex.reps}r` : ex.reps;
        steps.push({
          messageIndex: steps.length,
          name: `${ex.name} ${repStr}`.slice(0, STEP_NAME_BYTES - 1),
          durationType: FIT_WKT_STEP_DURATION.open,
          durationValue: 0,
          targetType: FIT_WKT_STEP_TARGET.open,
          targetValue: 0,
          customTargetLow: 0,
          customTargetHigh: 0,
          intensity: baseIntensity,
        });

        if (ex.rest_s > 0) {
          steps.push({
            messageIndex: steps.length,
            name: "Rest",
            durationType: FIT_WKT_STEP_DURATION.time,
            durationValue: ex.rest_s * 1000,
            targetType: FIT_WKT_STEP_TARGET.open,
            targetValue: 0,
            customTargetLow: 0,
            customTargetHigh: 0,
            intensity: FIT_INTENSITY.rest,
          });
        }

        if (ex.sets > 1) {
          steps.push({
            messageIndex: steps.length,
            name: `${ex.sets} sets`,
            durationType: FIT_WKT_STEP_DURATION.repeat_until_steps_cmplt,
            durationValue: startIndex,
            targetType: FIT_WKT_STEP_TARGET.open,
            targetValue: ex.sets,
            customTargetLow: 0,
            customTargetHigh: 0,
            intensity: baseIntensity,
          });
        }
      }
    }
    return {
      sport: FIT_SPORT_TRAINING,
      subSport: FIT_SUB_SPORT_STRENGTH_TRAINING,
      steps,
    };
  }

  const bikeSpec = spec as WorkoutSpec;
  for (const step of bikeSpec.steps) {
    if (step.type === "repeat") {
      const startIndex = steps.length;
      for (const inner of step.steps) {
        steps.push(buildCyclingStep(inner, steps.length, ftpWatts));
      }
      steps.push({
        messageIndex: steps.length,
        name: step.label ?? `Repeat x${step.count}`,
        durationType: FIT_WKT_STEP_DURATION.repeat_until_steps_cmplt,
        durationValue: startIndex,
        targetType: FIT_WKT_STEP_TARGET.open,
        targetValue: step.count,
        customTargetLow: 0,
        customTargetHigh: 0,
        intensity: FIT_INTENSITY.active,
      });
    } else {
      steps.push(buildCyclingStep(step, steps.length, ftpWatts));
    }
  }
  return { sport: FIT_SPORT_CYCLING, subSport: FIT_SUB_SPORT_GENERIC, steps };
}

export interface EncodeFitWorkoutOptions {
  ftpWatts?: number;
  thresholdPaceSPerKm?: number | null;
  createdAtIso?: string;
}

/**
 * Pure-TypeScript Garmin .FIT Workout binary encoder (file_type = 5).
 * Produces spec-compliant FIT v2 binary files compatible with Garmin watches
 * (drop into GARMIN/NewFiles/ or import into Garmin Connect).
 */
export function encodeWorkoutToFit(
  spec: AnyWorkoutSpec,
  options: EncodeFitWorkoutOptions = {}
): Uint8Array {
  const ftpWatts = options.ftpWatts && options.ftpWatts > 50 ? options.ftpWatts : 250;
  const thresholdPace =
    options.thresholdPaceSPerKm && options.thresholdPaceSPerKm >= 150
      ? options.thresholdPaceSPerKm
      : DEFAULT_THRESHOLD_PACE_S_PER_KM;
  const createdUnixS = options.createdAtIso
    ? Math.floor(new Date(options.createdAtIso).getTime() / 1000)
    : Math.floor(Date.now() / 1000);
  const fitTimestamp = Math.max(1, createdUnixS - FIT_EPOCH_UNIX_S);

  const { sport, subSport, steps } = buildWorkoutSteps(spec, ftpWatts, thresholdPace);
  const data: number[] = [];

  // 1. Definition + Data for file_id (global msg 0, local msg 0)
  data.push(
    0x40, // Definition header, local msg 0
    0x00, // reserved
    0x00, // architecture: little-endian
    0x00, 0x00, // global msg 0 (file_id)
    5, // 5 fields
    0, 1, 0x00, // type (enum)
    1, 2, 0x84, // manufacturer (uint16)
    2, 2, 0x84, // product (uint16)
    3, 4, 0x8c, // serial_number (uint32z)
    4, 4, 0x86 // time_created (uint32)
  );
  data.push(0x00); // Data header, local msg 0
  data.push(FIT_FILE_TYPE_WORKOUT);
  pushU16LE(data, 1); // Garmin
  pushU16LE(data, 1); // product
  pushU32LE(data, hashSerialNumber(`${spec.name}:${fitTimestamp}`));
  pushU32LE(data, fitTimestamp);

  // 2. Definition + Data for workout (global msg 26, local msg 1)
  data.push(
    0x41, // Definition header, local msg 1
    0x00, // reserved
    0x00, // little-endian
    26, 0x00, // global msg 26 (workout)
    5, // 5 fields
    4, 1, 0x00, // sport (enum)
    5, 4, 0x8c, // capabilities (uint32z)
    6, 2, 0x84, // num_valid_steps (uint16)
    8, WORKOUT_NAME_BYTES, 0x07, // wkt_name (string)
    11, 1, 0x00 // sub_sport (enum)
  );
  data.push(0x01); // Data header, local msg 1
  data.push(sport);
  pushU32LE(data, 0x00000020);
  pushU16LE(data, steps.length);
  data.push(...encodeFixedAscii(spec.name, WORKOUT_NAME_BYTES));
  data.push(subSport);

  // 3. Definition + Data for workout_step (global msg 27, local msg 2)
  data.push(
    0x42, // Definition header, local msg 2
    0x00, // reserved
    0x00, // little-endian
    27, 0x00, // global msg 27 (workout_step)
    9, // 9 fields
    254, 2, 0x84, // message_index (uint16)
    0, STEP_NAME_BYTES, 0x07, // wkt_step_name (string)
    1, 1, 0x00, // duration_type (enum)
    2, 4, 0x86, // duration_value (uint32)
    3, 1, 0x00, // target_type (enum)
    4, 4, 0x86, // target_value (uint32)
    5, 4, 0x86, // custom_target_value_low (uint32)
    6, 4, 0x86, // custom_target_value_high (uint32)
    7, 1, 0x00 // intensity (enum)
  );

  for (const step of steps) {
    data.push(0x02); // Data header, local msg 2
    pushU16LE(data, step.messageIndex);
    data.push(...encodeFixedAscii(step.name, STEP_NAME_BYTES));
    data.push(step.durationType);
    pushU32LE(data, step.durationValue);
    data.push(step.targetType);
    pushU32LE(data, step.targetValue);
    pushU32LE(data, step.customTargetLow);
    pushU32LE(data, step.customTargetHigh);
    data.push(step.intensity);
  }

  // Build 14-byte FIT header + data + 2-byte file CRC
  const totalBytes = 14 + data.length + 2;
  const out = new Uint8Array(totalBytes);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 14);
  dv.setUint8(1, FIT_PROTOCOL_VERSION);
  dv.setUint16(2, FIT_PROFILE_VERSION, true);
  dv.setUint32(4, data.length, true);
  out[8] = 0x2e; // '.'
  out[9] = 0x46; // 'F'
  out[10] = 0x49; // 'I'
  out[11] = 0x54; // 'T'
  const headerCrc = computeFitCrc16(out, 0, 12);
  dv.setUint16(12, headerCrc, true);

  out.set(data, 14);

  const fileCrc = computeFitCrc16(out, 0, 14 + data.length);
  dv.setUint16(14 + data.length, fileCrc, true);
  return out;
}

export interface DecodedFitWorkoutStep {
  message_index: number;
  name: string;
  duration_type: number;
  duration_value: number;
  target_type: number;
  target_value: number;
  custom_target_low: number;
  custom_target_high: number;
  intensity: number;
}

export interface DecodedFitWorkout {
  validHeader: boolean;
  validHeaderCrc: boolean;
  validFileCrc: boolean;
  fileType: number | null;
  sport: number | null;
  subSport: number | null;
  workoutName: string | null;
  numValidSteps: number | null;
  steps: DecodedFitWorkoutStep[];
}

export function decodeFitWorkout(bytes: Uint8Array): DecodedFitWorkout {
  if (bytes.length < 16) {
    return {
      validHeader: false,
      validHeaderCrc: false,
      validFileCrc: false,
      fileType: null,
      sport: null,
      subSport: null,
      workoutName: null,
      numValidSteps: null,
      steps: [],
    };
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = dv.getUint8(0);
  const dataSize = dv.getUint32(4, true);
  const sig = String.fromCharCode(
    bytes[8] ?? 0,
    bytes[9] ?? 0,
    bytes[10] ?? 0,
    bytes[11] ?? 0
  );
  const validHeader = headerSize === 14 && sig === ".FIT" && headerSize + dataSize + 2 === bytes.length;
  const expectedHeaderCrc = computeFitCrc16(bytes, 0, 12);
  const validHeaderCrc = validHeader && dv.getUint16(12, true) === expectedHeaderCrc;
  const expectedFileCrc = computeFitCrc16(bytes, 0, headerSize + dataSize);
  const validFileCrc =
    validHeader && dv.getUint16(headerSize + dataSize, true) === expectedFileCrc;

  const defs = new Map<
    number,
    { littleEndian: boolean; globalMsg: number; fields: { num: number; size: number; type: number }[] }
  >();
  let cursor = headerSize;
  const dataEnd = Math.min(bytes.length, headerSize + dataSize);

  let fileType: number | null = null;
  let sport: number | null = null;
  let subSport: number | null = null;
  let workoutName: string | null = null;
  let numValidSteps: number | null = null;
  const steps: DecodedFitWorkoutStep[] = [];

  while (cursor < dataEnd) {
    const hdr = bytes[cursor++] ?? 0;
    const isDef = (hdr & 0x40) !== 0;
    const localNum = hdr & 0x0f;

    if (isDef) {
      cursor += 1; // reserved
      const arch = bytes[cursor++] ?? 0;
      const littleEndian = arch === 0;
      const globalMsg = dv.getUint16(cursor, littleEndian);
      cursor += 2;
      const numFields = bytes[cursor++] ?? 0;
      const fields: { num: number; size: number; type: number }[] = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({
          num: bytes[cursor++] ?? 0,
          size: bytes[cursor++] ?? 0,
          type: bytes[cursor++] ?? 0,
        });
      }
      defs.set(localNum, { littleEndian, globalMsg, fields });
      continue;
    }

    const def = defs.get(localNum);
    if (!def) break;

    const stepRecord: DecodedFitWorkoutStep = {
      message_index: 0,
      name: "",
      duration_type: 0,
      duration_value: 0,
      target_type: 0,
      target_value: 0,
      custom_target_low: 0,
      custom_target_high: 0,
      intensity: 0,
    };

    for (const f of def.fields) {
      const off = cursor;
      cursor += f.size;
      const readU = (): number => {
        if (f.size === 1) return dv.getUint8(off);
        if (f.size === 2) return dv.getUint16(off, def.littleEndian);
        if (f.size === 4) return dv.getUint32(off, def.littleEndian);
        return 0;
      };

      if (def.globalMsg === 0 && f.num === 0) {
        fileType = readU();
      } else if (def.globalMsg === 26) {
        if (f.num === 4) sport = readU();
        else if (f.num === 6) numValidSteps = readU();
        else if (f.num === 8) workoutName = decodeFixedAscii(bytes, off, f.size);
        else if (f.num === 11) subSport = readU();
      } else if (def.globalMsg === 27) {
        if (f.num === 254) stepRecord.message_index = readU();
        else if (f.num === 0) stepRecord.name = decodeFixedAscii(bytes, off, f.size);
        else if (f.num === 1) stepRecord.duration_type = readU();
        else if (f.num === 2) stepRecord.duration_value = readU();
        else if (f.num === 3) stepRecord.target_type = readU();
        else if (f.num === 4) stepRecord.target_value = readU();
        else if (f.num === 5) stepRecord.custom_target_low = readU();
        else if (f.num === 6) stepRecord.custom_target_high = readU();
        else if (f.num === 7) stepRecord.intensity = readU();
      }
    }

    if (def.globalMsg === 27) {
      steps.push(stepRecord);
    }
  }

  return {
    validHeader,
    validHeaderCrc,
    validFileCrc,
    fileType,
    sport,
    subSport,
    workoutName,
    numValidSteps,
    steps,
  };
}
