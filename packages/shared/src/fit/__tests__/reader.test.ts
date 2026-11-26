import { describe, it, expect } from "vitest";
import { parseFitRecords, downsampleRecords } from "../../index.js";

function buildTestFitFile(
  records: { ts: number; hr: number; cadence: number; watts: number; speedCms: number }[]
): Uint8Array {
  // Definition for Record (global msg 20, local 0, little-endian) with fields 253(u32), 3(u8), 4(u8), 7(u16), 6(u16)
  const def = [
    0x40, // definition msg, local 0
    0x00, // reserved
    0x00, // architecture: little-endian
    20,
    0, // globalMsgNum = 20
    5, // numFields
    253,
    4,
    0x86, // timestamp
    3,
    1,
    0x02, // heart_rate
    4,
    1,
    0x02, // cadence
    7,
    2,
    0x84, // power
    6,
    2,
    0x84, // speed (mm/s)
  ];

  const dataMsgs: number[] = [];
  for (const r of records) {
    const buf = new ArrayBuffer(11);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x00); // data msg, local 0
    dv.setUint32(1, r.ts, true);
    dv.setUint8(5, r.hr);
    dv.setUint8(6, r.cadence);
    dv.setUint16(7, r.watts, true);
    dv.setUint16(9, r.speedCms, true);
    dataMsgs.push(...new Uint8Array(buf));
  }

  const dataBytes = [...def, ...dataMsgs];
  const header = new Uint8Array(14);
  const hv = new DataView(header.buffer);
  hv.setUint8(0, 14); // header size
  hv.setUint8(1, 0x20); // protocol v2
  hv.setUint16(2, 2100, true);
  hv.setUint32(4, dataBytes.length, true);
  header[8] = 0x2e; // .
  header[9] = 0x46; // F
  header[10] = 0x49; // I
  header[11] = 0x54; // T

  return new Uint8Array([...header, ...dataBytes, 0x00, 0x00]);
}

describe("FIT Binary Reader", () => {
  it("decodes FIT v2.0 record messages, ignores invalid sentinels, and downsamples buckets", () => {
    const baseTs = 1_164_640_000;
    const fitBytes = buildTestFitFile([
      { ts: baseTs, hr: 130, cadence: 85, watts: 200, speedCms: 8000 },
      { ts: baseTs + 1, hr: 132, cadence: 87, watts: 210, speedCms: 8200 },
      { ts: baseTs + 30, hr: 0xff, cadence: 90, watts: 0xffff, speedCms: 9000 },
    ]);

    const parsed = parseFitRecords(fitBytes);
    expect(parsed.startTimeIso).toBeTruthy();
    expect(parsed.samples).toHaveLength(3);
    expect(parsed.samples[0]).toEqual({
      t_s: 0,
      watts: 200,
      hr_bpm: 130,
      cadence_rpm: 85,
      speed_kph: 28.8,
    });
    // Invalid sentinels mapped cleanly to null
    expect(parsed.samples[2]?.watts).toBeNull();
    expect(parsed.samples[2]?.hr_bpm).toBeNull();
    expect(parsed.samples[2]?.t_s).toBe(30);

    const downsampled = downsampleRecords(parsed.samples, 30);
    expect(downsampled).toHaveLength(2);
    expect(downsampled[0]?.watts).toBe(205);
    expect(downsampled[0]?.hr_bpm).toBe(131);
  });
});
