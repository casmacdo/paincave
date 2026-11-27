import type { TelemetrySample } from "../physiology/metrics.js";

const FIT_EPOCH_UNIX_S = 631065600; // 1989-12-31T00:00:00Z

export type NormalizedFitSport = "cycling" | "running" | "strength" | "mobility" | "other";

export interface ParsedFitLap {
  lap_index: number;
  start_time_iso: string | null;
  duration_s: number;
  elapsed_s: number;
  distance_m: number | null;
  avg_speed_mps: number | null;
  avg_pace_s_per_km: number | null;
  avg_power: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_cadence: number | null;
  elevation_gain_m: number | null;
  elevation_loss_m: number | null;
}

interface FitFieldDef {
  fieldNum: number;
  size: number;
  baseType: number;
}

interface FitLocalDef {
  littleEndian: boolean;
  globalMsgNum: number;
  fields: FitFieldDef[];
  devBytes: number;
}

export interface ParsedFitRide {
  startTimeIso: string | null;
  sport: NormalizedFitSport;
  sportCode: number | null;
  subSport: number | null;
  subSportName: string | null;
  hasGps: boolean;
  totalDistanceM: number | null;
  totalAscentM: number | null;
  totalDescentM: number | null;
  totalTimerTimeS: number | null;
  totalElapsedTimeS: number | null;
  laps: ParsedFitLap[];
  samples: TelemetrySample[];
}

export function mapFitSportCode(
  sportCode: number | null,
  subSportCode: number | null
): NormalizedFitSport {
  if (sportCode === 1) return "running";
  if (sportCode === 2) return "cycling";
  if (sportCode === 10 || sportCode === 4) {
    // FIT sport=10 (training), sub_sport 20=strength_training, 43=flexibility/mobility, 44=pilates, 45=yoga
    if (subSportCode === 43 || subSportCode === 44 || subSportCode === 45) return "mobility";
    return "strength";
  }
  if (sportCode === 11) return "running"; // walking/hiking fallback if needed -> map to other unless running
  if (sportCode === null) return "cycling"; // default for legacy cycling FITs without sport field
  return "other";
}

export function mapFitSubSportName(subSport: number | null): string | null {
  switch (subSport) {
    case 1:
      return "treadmill";
    case 2:
      return "street";
    case 3:
      return "trail";
    case 4:
      return "track";
    case 5:
      return "spin";
    case 6:
      return "indoor_cycling";
    case 7:
      return "road";
    case 8:
      return "mountain";
    case 20:
      return "strength_training";
    case 43:
    case 44:
    case 45:
      return "mobility";
    case 58:
      return "virtual_activity";
    default:
      return null;
  }
}

function readUInt(
  bytes: Uint8Array,
  offset: number,
  size: number,
  littleEndian: boolean
): number | null {
  if (offset + size > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, size);
  if (size === 1) return view.getUint8(0);
  if (size === 2) return view.getUint16(0, littleEndian);
  if (size === 4) return view.getUint32(0, littleEndian);
  return null;
}

function readSInt32(
  bytes: Uint8Array,
  offset: number,
  littleEndian: boolean
): number | null {
  if (offset + 4 > bytes.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getInt32(0, littleEndian);
}

function fitTimestampToIso(fitTs: number): string {
  return new Date((FIT_EPOCH_UNIX_S + fitTs) * 1000).toISOString();
}

/**
 * Pure-TypeScript FIT v1/v2 decoder extracting multi-sport session metadata (msg 18),
 * lap splits (msg 19), and 1Hz telemetry records (msg 20) without external dependencies.
 */
export function parseFitRecords(fitBytes: Uint8Array): ParsedFitRide {
  if (fitBytes.length < 14) {
    throw new Error("FIT file too short");
  }
  const headerSize = fitBytes[0] ?? 0;
  if (headerSize < 12 || headerSize > fitBytes.length) {
    throw new Error(`Invalid FIT header size: ${headerSize}`);
  }
  const sig = String.fromCharCode(
    fitBytes[8] ?? 0,
    fitBytes[9] ?? 0,
    fitBytes[10] ?? 0,
    fitBytes[11] ?? 0
  );
  if (sig !== ".FIT") {
    throw new Error("Invalid FIT signature");
  }

  const headerView = new DataView(fitBytes.buffer, fitBytes.byteOffset, headerSize);
  const dataSize = headerView.getUint32(4, true);
  const dataEnd = Math.min(fitBytes.length, headerSize + dataSize);

  const localDefs = new Map<number, FitLocalDef>();
  const rawRecords: {
    ts: number | null;
    watts: number | null;
    hr: number | null;
    cadence: number | null;
    speedKph: number | null;
    distanceM: number | null;
    latDeg: number | null;
    lonDeg: number | null;
    elevationM: number | null;
  }[] = [];
  const laps: ParsedFitLap[] = [];

  let cursor = headerSize;
  let lastTimestamp = 0;
  let startTimeFit: number | null = null;
  let sportCode: number | null = null;
  let subSport: number | null = null;
  let totalDistanceM: number | null = null;
  let totalAscentM: number | null = null;
  let totalDescentM: number | null = null;
  let totalTimerTimeS: number | null = null;
  let totalElapsedTimeS: number | null = null;
  let hasGps = false;

  while (cursor < dataEnd) {
    const header = fitBytes[cursor++];
    if (header === undefined) break;

    const isCompressedTs = (header & 0x80) !== 0;
    const isDefinition = !isCompressedTs && (header & 0x40) !== 0;

    if (isDefinition) {
      const localNum = header & 0x0f;
      const hasDevData = (header & 0x20) !== 0;
      if (cursor + 5 > dataEnd) break;

      cursor += 1; // reserved
      const arch = fitBytes[cursor++] ?? 0;
      const littleEndian = arch === 0;
      const globalMsgNum = readUInt(fitBytes, cursor, 2, littleEndian);
      cursor += 2;
      const numFields = fitBytes[cursor++] ?? 0;
      if (globalMsgNum === null || cursor + numFields * 3 > dataEnd) break;

      const fields: FitFieldDef[] = [];
      for (let i = 0; i < numFields; i++) {
        fields.push({
          fieldNum: fitBytes[cursor++] ?? 0,
          size: fitBytes[cursor++] ?? 0,
          baseType: fitBytes[cursor++] ?? 0,
        });
      }

      let devBytes = 0;
      if (hasDevData) {
        if (cursor >= dataEnd) break;
        const numDev = fitBytes[cursor++] ?? 0;
        if (cursor + numDev * 3 > dataEnd) break;
        for (let i = 0; i < numDev; i++) {
          cursor += 1;
          devBytes += fitBytes[cursor++] ?? 0;
          cursor += 1;
        }
      }

      localDefs.set(localNum, { littleEndian, globalMsgNum, fields, devBytes });
      continue;
    }

    const localNum = isCompressedTs ? (header >> 5) & 0x03 : header & 0x0f;
    const def = localDefs.get(localNum);
    if (!def) {
      break;
    }

    let compressedTs: number | null = null;
    if (isCompressedTs) {
      const timeOffset = header & 0x1f;
      const low5 = lastTimestamp & 0x1f;
      compressedTs =
        timeOffset >= low5
          ? (lastTimestamp & ~0x1f) + timeOffset
          : (lastTimestamp & ~0x1f) + 0x20 + timeOffset;
      lastTimestamp = compressedTs;
    }

    // Record fields (msg 20)
    let ts: number | null = compressedTs;
    let watts: number | null = null;
    let hr: number | null = null;
    let cadence: number | null = null;
    let speedKph: number | null = null;
    let distanceM: number | null = null;
    let latDeg: number | null = null;
    let lonDeg: number | null = null;
    let elevationM: number | null = null;

    // Lap fields (msg 19)
    let lapStartTs: number | null = null;
    let lapElapsedS: number | null = null;
    let lapTimerS: number | null = null;
    let lapDistanceM: number | null = null;
    let lapAvgSpeedMps: number | null = null;
    let lapAvgHr: number | null = null;
    let lapMaxHr: number | null = null;
    let lapAvgCadence: number | null = null;
    let lapAvgPower: number | null = null;
    let lapAscentM: number | null = null;
    let lapDescentM: number | null = null;

    for (const f of def.fields) {
      if (cursor + f.size > dataEnd) {
        cursor = dataEnd;
        break;
      }
      const fieldOffset = cursor;
      const val = readUInt(fitBytes, fieldOffset, f.size, def.littleEndian);
      cursor += f.size;
      if (val === null) continue;

      if (def.globalMsgNum === 20) {
        if (f.fieldNum === 253 && f.size === 4 && val !== 0xffffffff) {
          ts = val;
          lastTimestamp = val;
        } else if (f.fieldNum === 0 && f.size === 4) {
          const semicircles = readSInt32(fitBytes, fieldOffset, def.littleEndian);
          if (semicircles !== null && semicircles !== 0x7fffffff) {
            latDeg = (semicircles * 180) / 2_147_483_648;
            hasGps = true;
          }
        } else if (f.fieldNum === 1 && f.size === 4) {
          const semicircles = readSInt32(fitBytes, fieldOffset, def.littleEndian);
          if (semicircles !== null && semicircles !== 0x7fffffff) {
            lonDeg = (semicircles * 180) / 2_147_483_648;
            hasGps = true;
          }
        } else if (f.fieldNum === 2 && f.size === 2 && val !== 0xffff) {
          elevationM = Number((val / 5 - 500).toFixed(1));
        } else if (f.fieldNum === 78 && f.size === 4 && val !== 0xffffffff) {
          elevationM = Number((val / 5 - 500).toFixed(1));
        } else if (f.fieldNum === 3 && f.size === 1 && val !== 0xff) {
          hr = val;
        } else if (f.fieldNum === 4 && f.size === 1 && val !== 0xff) {
          cadence = val;
        } else if (f.fieldNum === 5 && f.size === 4 && val !== 0xffffffff) {
          distanceM = Number((val / 100).toFixed(2));
        } else if (f.fieldNum === 7 && f.size === 2 && val !== 0xffff) {
          watts = val;
        } else if (f.fieldNum === 6 && f.size === 2 && val !== 0xffff) {
          speedKph = Number(((val / 1000) * 3.6).toFixed(1));
        } else if (f.fieldNum === 73 && f.size === 4 && val !== 0xffffffff) {
          speedKph = Number(((val / 1000) * 3.6).toFixed(1));
        }
      } else if (def.globalMsgNum === 19) {
        // Lap message
        if (f.fieldNum === 2 && f.size === 4 && val !== 0xffffffff) {
          lapStartTs = val;
        } else if (f.fieldNum === 7 && f.size === 4 && val !== 0xffffffff) {
          lapElapsedS = Math.round(val / 1000);
        } else if (f.fieldNum === 8 && f.size === 4 && val !== 0xffffffff) {
          lapTimerS = Math.round(val / 1000);
        } else if (f.fieldNum === 9 && f.size === 4 && val !== 0xffffffff) {
          lapDistanceM = Number((val / 100).toFixed(2));
        } else if (f.fieldNum === 13 && f.size === 2 && val !== 0xffff) {
          lapAvgSpeedMps = val / 1000;
        } else if (f.fieldNum === 110 && f.size === 4 && val !== 0xffffffff) {
          lapAvgSpeedMps = val / 1000;
        } else if (f.fieldNum === 15 && f.size === 1 && val !== 0xff) {
          lapAvgHr = val;
        } else if (f.fieldNum === 16 && f.size === 1 && val !== 0xff) {
          lapMaxHr = val;
        } else if (f.fieldNum === 17 && f.size === 1 && val !== 0xff) {
          lapAvgCadence = val;
        } else if (f.fieldNum === 19 && f.size === 2 && val !== 0xffff) {
          lapAvgPower = val;
        } else if (f.fieldNum === 21 && f.size === 2 && val !== 0xffff) {
          lapAscentM = val;
        } else if (f.fieldNum === 22 && f.size === 2 && val !== 0xffff) {
          lapDescentM = val;
        }
      } else if (def.globalMsgNum === 18) {
        // Session message
        if (f.fieldNum === 2 && f.size === 4 && val !== 0xffffffff && startTimeFit === null) {
          startTimeFit = val;
        } else if (f.fieldNum === 5 && f.size === 1 && val !== 0xff && sportCode === null) {
          sportCode = val;
        } else if (f.fieldNum === 6 && f.size === 1 && val !== 0xff && subSport === null) {
          subSport = val;
        } else if (f.fieldNum === 7 && f.size === 4 && val !== 0xffffffff) {
          totalElapsedTimeS = Math.round(val / 1000);
        } else if (f.fieldNum === 8 && f.size === 4 && val !== 0xffffffff) {
          totalTimerTimeS = Math.round(val / 1000);
        } else if (f.fieldNum === 9 && f.size === 4 && val !== 0xffffffff) {
          totalDistanceM = Number((val / 100).toFixed(2));
        } else if (f.fieldNum === 22 && f.size === 2 && val !== 0xffff) {
          totalAscentM = val;
        } else if (f.fieldNum === 23 && f.size === 2 && val !== 0xffff) {
          totalDescentM = val;
        }
      } else if (def.globalMsgNum === 0) {
        // FileId message: time_created = field 4
        if (f.fieldNum === 4 && f.size === 4 && val !== 0xffffffff && startTimeFit === null) {
          startTimeFit = val;
        }
      }
    }

    cursor += def.devBytes;

    if (def.globalMsgNum === 20) {
      rawRecords.push({
        ts,
        watts,
        hr,
        cadence,
        speedKph,
        distanceM,
        latDeg,
        lonDeg,
        elevationM,
      });
    } else if (def.globalMsgNum === 19) {
      const durationS = lapTimerS ?? lapElapsedS ?? 0;
      const resolvedSpeed =
        lapAvgSpeedMps ?? (lapDistanceM && durationS > 0 ? lapDistanceM / durationS : null);
      const pace =
        resolvedSpeed && resolvedSpeed > 0.2 ? Number((1000 / resolvedSpeed).toFixed(1)) : null;
      laps.push({
        lap_index: laps.length,
        start_time_iso: lapStartTs !== null ? fitTimestampToIso(lapStartTs) : null,
        duration_s: durationS,
        elapsed_s: lapElapsedS ?? durationS,
        distance_m: lapDistanceM,
        avg_speed_mps: resolvedSpeed !== null ? Number(resolvedSpeed.toFixed(3)) : null,
        avg_pace_s_per_km: pace,
        avg_power: lapAvgPower,
        avg_hr: lapAvgHr,
        max_hr: lapMaxHr,
        avg_cadence: lapAvgCadence,
        elevation_gain_m: lapAscentM,
        elevation_loss_m: lapDescentM,
      });
    }
  }

  const firstTs = rawRecords.find((r) => r.ts !== null)?.ts ?? startTimeFit;
  const samples: TelemetrySample[] = rawRecords.map((r, idx) => ({
    t_s: r.ts !== null && firstTs !== null ? Math.max(0, r.ts - firstTs) : idx,
    watts: r.watts,
    hr_bpm: r.hr,
    cadence_rpm: r.cadence,
    speed_kph: r.speedKph,
    ...(r.distanceM !== null ? { distance_m: r.distanceM } : {}),
    ...(r.latDeg !== null ? { lat_deg: r.latDeg } : {}),
    ...(r.lonDeg !== null ? { lon_deg: r.lonDeg } : {}),
    ...(r.elevationM !== null ? { elevation_m: r.elevationM } : {}),
  }));

  const resolvedStart = startTimeFit ?? firstTs;
  return {
    startTimeIso: resolvedStart !== null ? fitTimestampToIso(resolvedStart) : null,
    sport: mapFitSportCode(sportCode, subSport),
    sportCode,
    subSport,
    subSportName: mapFitSubSportName(subSport),
    hasGps,
    totalDistanceM,
    totalAscentM,
    totalDescentM,
    totalTimerTimeS,
    totalElapsedTimeS,
    laps,
    samples,
  };
}

export interface DownsampledPoint {
  t_s: number;
  watts: number | null;
  hr_bpm: number | null;
  cadence_rpm: number | null;
  speed_kph: number | null;
}

export function downsampleRecords(
  samples: readonly TelemetrySample[],
  bucketSeconds = 30
): DownsampledPoint[] {
  const bucket = Math.max(1, Math.round(bucketSeconds));
  if (samples.length === 0) return [];
  if (bucket === 1) {
    return samples.map((s) => ({
      t_s: s.t_s,
      watts: s.watts,
      hr_bpm: s.hr_bpm,
      cadence_rpm: s.cadence_rpm,
      speed_kph: s.speed_kph ?? null,
    }));
  }

  const buckets = new Map<number, TelemetrySample[]>();
  for (const s of samples) {
    const key = Math.floor(s.t_s / bucket) * bucket;
    const arr = buckets.get(key);
    if (arr) arr.push(s);
    else buckets.set(key, [s]);
  }

  const avgNullable = (vals: (number | null | undefined)[]): number | null => {
    let sum = 0;
    let cnt = 0;
    for (const v of vals) {
      if (v !== null && v !== undefined) {
        sum += v;
        cnt++;
      }
    }
    return cnt > 0 ? Math.round(sum / cnt) : null;
  };

  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([tS, group]) => {
      let spdSum = 0;
      let spdCnt = 0;
      for (const s of group) {
        if (s.speed_kph !== null && s.speed_kph !== undefined) {
          spdSum += s.speed_kph;
          spdCnt++;
        }
      }
      return {
        t_s: tS,
        watts: avgNullable(group.map((g) => g.watts)),
        hr_bpm: avgNullable(group.map((g) => g.hr_bpm)),
        cadence_rpm: avgNullable(group.map((g) => g.cadence_rpm)),
        speed_kph: spdCnt > 0 ? Number((spdSum / spdCnt).toFixed(1)) : null,
      };
    });
}
