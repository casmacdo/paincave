/**
 * Extracts a `.fit` payload from a ZIP archive when Garmin Connect (or Strava bulk export)
 * wraps an activity FIT file in a ZIP container.
 *
 * Handles both standard ZIP local file headers AND streaming ZIPs (bit 3 data descriptor,
 * e.g. Java ZipOutputStream used by Garmin Connect Personal API where local header
 * compressed size is 0 and real sizes live in the Central Directory).
 */

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function isZipBytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 30 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

async function decompressEntry(payload: Uint8Array, method: number): Promise<Uint8Array | null> {
  if (method === 0) {
    return payload.slice();
  }
  if (method === 8) {
    const ds = new DecompressionStream("deflate-raw");
    const writer = ds.writable.getWriter();
    const writePromise = writer
      .write(payload)
      .then(() => writer.close())
      .catch(() => {});
    const outBuf = await new Response(ds.readable).arrayBuffer();
    await writePromise;
    return new Uint8Array(outBuf);
  }
  return null;
}

interface ZipEntryRef {
  fileName: string;
  method: number;
  compSize: number;
  localHeaderOffset: number;
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const minOffset = Math.max(0, bytes.length - 22 - 65_535);
  for (let i = bytes.length - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      return i;
    }
  }
  return -1;
}

function readCentralDirectoryEntries(bytes: Uint8Array, view: DataView): ZipEntryRef[] {
  const eocdOffset = findEndOfCentralDirectory(bytes, view);
  if (eocdOffset < 0) return [];

  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  if (cdOffset >= bytes.length || cdOffset + cdSize > bytes.length) {
    return [];
  }

  const decoder = new TextDecoder();
  const entries: ZipEntryRef[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < totalEntries && cursor + 46 <= cdOffset + cdSize; i++) {
    if (view.getUint32(cursor, true) !== SIG_CENTRAL_DIR) break;
    const method = view.getUint16(cursor + 10, true);
    const compSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + 46;
    if (nameStart + nameLen > bytes.length) break;

    const fileName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen));
    if (!fileName.endsWith("/") && compSize > 0) {
      entries.push({ fileName, method, compSize, localHeaderOffset });
    }
    cursor = nameStart + nameLen + extraLen + commentLen;
  }

  return entries;
}

export async function unwrapFitZipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isZipBytes(bytes)) {
    return bytes;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // 1. Prefer Central Directory (works for both standard and streaming bit-3 data-descriptor ZIPs)
  const cdEntries = readCentralDirectoryEntries(bytes, view);
  if (cdEntries.length > 0) {
    const chosen =
      cdEntries.find((e) => e.fileName.toLowerCase().endsWith(".fit")) ?? cdEntries[0];
    if (chosen && chosen.localHeaderOffset + 30 <= bytes.length) {
      if (view.getUint32(chosen.localHeaderOffset, true) === SIG_LOCAL_HEADER) {
        const localNameLen = view.getUint16(chosen.localHeaderOffset + 26, true);
        const localExtraLen = view.getUint16(chosen.localHeaderOffset + 28, true);
        const dataStart = chosen.localHeaderOffset + 30 + localNameLen + localExtraLen;
        if (dataStart + chosen.compSize <= bytes.length) {
          const payload = bytes.subarray(dataStart, dataStart + chosen.compSize);
          const extracted = await decompressEntry(payload, chosen.method);
          if (extracted && extracted.byteLength >= 14) {
            return extracted;
          }
        }
      }
    }
  }

  // 2. Fallback: walk local file headers directly if EOCD is truncated
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== SIG_LOCAL_HEADER) break;
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    if (nameStart + nameLen > bytes.length) break;
    const fileName = decoder.decode(bytes.subarray(nameStart, nameStart + nameLen)).toLowerCase();

    if (compSize > 0 && dataStart + compSize <= bytes.length) {
      const payload = bytes.subarray(dataStart, dataStart + compSize);
      if (fileName.endsWith(".fit") || offset === 0) {
        const extracted = await decompressEntry(payload, method);
        if (extracted && extracted.byteLength >= 14) {
          return extracted;
        }
      }
      offset = dataStart + compSize;
    } else {
      break;
    }
  }

  return bytes;
}
