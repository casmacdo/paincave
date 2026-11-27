#!/usr/bin/env node
/**
 * Local Bulk Archive Importer for PainCave (Strava Account Export & Garmin Account Export).
 *
 * Parses 3,000+ historical .fit / .fit.gz / .gpx.gz files locally on your workstation and
 * uploads normalized summaries + raw .fit files in idempotent, resumable batches.
 *
 * Usage:
 *   node --experimental-strip-types scripts/import-archive.ts \
 *     --dir /path/to/unzipped-strava-or-garmin-export \
 *     --url https://your-worker.workers.dev \
 *     --token pc_importer_... \
 *     [--batch-size 20] [--ftp 250] [--threshold-pace 270] [--skip-fit-upload] [--dry-run]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  buildArchiveActivityItem,
  parseGarminWellnessExportJson,
  parseStravaActivitiesCsv,
  type ArchiveBiometricsRow,
  type NormalizedArchiveBatchItem,
} from "../packages/shared/src/import/archive.ts";

interface CliOpts {
  dir: string;
  url: string;
  token: string;
  batchSize: number;
  ftpWatts: number;
  thresholdPace: number | null;
  skipFitUpload: boolean;
  dryRun: boolean;
}

function parseCliArgs(argv: string[]): CliOpts {
  let dir = "";
  let url = "";
  let token = "";
  let batchSize = 20;
  let ftpWatts = 250;
  let thresholdPace: number | null = null;
  let skipFitUpload = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir" && argv[i + 1]) dir = argv[++i]!;
    else if (arg === "--url" && argv[i + 1]) url = argv[++i]!.replace(/\/+$/, "");
    else if (arg === "--token" && argv[i + 1]) token = argv[++i]!;
    else if (arg === "--batch-size" && argv[i + 1]) batchSize = Math.min(50, Math.max(1, Number(argv[++i])));
    else if (arg === "--ftp" && argv[i + 1]) ftpWatts = Number(argv[++i]) || 250;
    else if (arg === "--threshold-pace" && argv[i + 1]) thresholdPace = Number(argv[++i]) || null;
    else if (arg === "--skip-fit-upload") skipFitUpload = true;
    else if (arg === "--dry-run") dryRun = true;
  }

  if (!dir) {
    throw new Error("Missing required --dir <path-to-unzipped-export>");
  }
  if (!dryRun && (!url || !token)) {
    throw new Error("Non-dry-run mode requires --url <worker-url> and --token <importer-token>");
  }
  return { dir: path.resolve(dir), url, token, batchSize, ftpWatts, thresholdPace, skipFitUpload, dryRun };
}

function readMaybeGzipped(filePath: string): Uint8Array {
  const raw = fs.readFileSync(filePath);
  if (filePath.toLowerCase().endsWith(".gz") || (raw[0] === 0x1f && raw[1] === 0x8b)) {
    return new Uint8Array(zlib.gunzipSync(raw));
  }
  return new Uint8Array(raw);
}

function walkFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Importer-Token": token,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} from ${url}: ${txt.slice(0, 300)}`);
  }
  return (await resp.json()) as T;
}

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const stravaCsvPath = path.join(opts.dir, "activities.csv");

  const items: (NormalizedArchiveBatchItem & { fit_base64?: string })[] = [];
  const biometrics: ArchiveBiometricsRow[] = [];

  if (fs.existsSync(stravaCsvPath)) {
    console.log(`Detected Strava archive at ${opts.dir}`);
    const csvRows = parseStravaActivitiesCsv(fs.readFileSync(stravaCsvPath, "utf8"));
    console.log(`Found ${csvRows.length} activities in activities.csv`);

    for (const row of csvRows) {
      let fitBytes: Uint8Array | null = null;
      let gpxXml: string | null = null;
      if (row.filename) {
        const candidate = path.join(opts.dir, row.filename);
        if (fs.existsSync(candidate)) {
          const lower = candidate.toLowerCase();
          try {
            const bytes = readMaybeGzipped(candidate);
            if (lower.includes(".fit")) fitBytes = bytes;
            else if (lower.includes(".gpx")) gpxXml = new TextDecoder().decode(bytes);
          } catch {
            // Fall back to CSV metadata if individual archive file is corrupted
          }
        }
      }

      const item = buildArchiveActivityItem({
        rideUuid: crypto.randomUUID(),
        externalProvider: "strava_archive",
        externalId: row.external_id,
        name: row.name,
        startedAt: row.started_at,
        sport: row.sport,
        subSport: row.sub_sport,
        durationS: row.duration_s,
        elapsedS: row.elapsed_s,
        distanceM: row.distance_m,
        elevationGainM: row.elevation_gain_m,
        avgHr: row.avg_hr,
        maxHr: row.max_hr,
        avgPower: row.avg_power,
        notes: row.description,
        ftpWatts: opts.ftpWatts,
        thresholdPaceSPerKm: opts.thresholdPace,
        fitBytes,
        gpxXml,
      });

      items.push({
        ...item,
        ...(fitBytes && !opts.skipFitUpload && fitBytes.byteLength <= 2_500_000
          ? { fit_base64: Buffer.from(fitBytes).toString("base64") }
          : {}),
      });
    }
  } else {
    console.log(`Scanning directory ${opts.dir} for Garmin .fit and wellness .json files...`);
    const allFiles = walkFiles(opts.dir);
    for (const file of allFiles) {
      const lower = file.toLowerCase();
      if (lower.endsWith(".fit") || lower.endsWith(".fit.gz")) {
        try {
          const fitBytes = readMaybeGzipped(file);
          const relId = path.relative(opts.dir, file).replaceAll("\\", "/");
          const item = buildArchiveActivityItem({
            rideUuid: crypto.randomUUID(),
            externalProvider: "garmin_archive",
            externalId: relId,
            name: path.basename(file).replace(/\.fit(\.gz)?$/i, ""),
            startedAt: new Date(fs.statSync(file).mtimeMs).toISOString(),
            sport: "other",
            ftpWatts: opts.ftpWatts,
            thresholdPaceSPerKm: opts.thresholdPace,
            fitBytes,
          });
          items.push({
            ...item,
            ...(fitBytes.byteLength <= 2_500_000 && !opts.skipFitUpload
              ? { fit_base64: Buffer.from(fitBytes).toString("base64") }
              : {}),
          });
        } catch {
          // Skip non-activity FIT files (e.g. monitoring/settings FITs)
        }
      } else if (lower.endsWith(".json") && (lower.includes("wellness") || lower.includes("sleep") || lower.includes("hrv") || lower.includes("udsfile"))) {
        try {
          const parsedJson: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
          biometrics.push(...parseGarminWellnessExportJson(parsedJson));
        } catch {
          // Skip non-wellness JSONs
        }
      }
    }
  }

  console.log(`Prepared ${items.length} activities and ${biometrics.length} daily biometric rows.`);
  if (opts.dryRun) {
    console.log("Dry-run complete (no network requests sent).");
    return;
  }

  let totalImported = 0;
  let totalSkipped = 0;

  for (let i = 0; i < items.length; i += opts.batchSize) {
    const slice = items.slice(i, i + opts.batchSize);
    const res = await postJson<{ imported: number; skipped: number }>(
      `${opts.url}/api/import/batch`,
      opts.token,
      {
        activities: slice,
        biometrics: i === 0 ? biometrics.slice(0, 100) : [],
        source: fs.existsSync(stravaCsvPath) ? "strava_archive" : "garmin_archive",
      }
    );
    totalImported += res.imported;
    totalSkipped += res.skipped;
    console.log(
      `Batch ${Math.floor(i / opts.batchSize) + 1}/${Math.ceil(items.length / opts.batchSize)}: +${res.imported} imported, ${res.skipped} skipped`
    );
  }

  // Upload remaining biometric chunks if > 100
  for (let b = 100; b < biometrics.length; b += 100) {
    await postJson(`${opts.url}/api/import/batch`, opts.token, {
      activities: [],
      biometrics: biometrics.slice(b, b + 100),
      source: "garmin_archive",
    });
  }

  const pmc = await postJson<{ days_computed: number; earliest_day: string | null }>(
    `${opts.url}/api/import/rebuild-pmc`,
    opts.token,
    {}
  );
  console.log(
    `Done! Imported ${totalImported}, skipped ${totalSkipped} duplicates. Rebuilt PMC (${pmc.days_computed} days from ${pmc.earliest_day ?? "n/a"}).`
  );
}

main().catch((err) => {
  console.error("Archive import failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
