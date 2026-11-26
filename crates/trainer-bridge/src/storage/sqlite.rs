use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Context;
use rusqlite::{Connection, OptionalExtension, params};

use crate::protocol::TelemetrySample;

#[derive(Debug, Clone)]
pub struct PendingUploadRow {
    pub ride_uuid: String,
    pub summary_json: String,
    pub fit_bytes: Vec<u8>,
    pub attempts: i64,
    pub next_retry_at: i64,
}

#[derive(Debug, Clone)]
pub struct RecoveredActiveRide {
    pub ride_uuid: String,
    pub name: String,
    pub started_at: String,
    pub sample_count: i64,
}

#[derive(Clone)]
pub struct SqliteStore {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteStore {
    pub fn open(path: &Path) -> anyhow::Result<Self> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS active_rides (
               ride_uuid TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               started_at TEXT NOT NULL,
               meta_json TEXT NOT NULL,
               finished INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS ride_samples (
               ride_uuid TEXT NOT NULL,
               t_s INTEGER NOT NULL,
               sample_json TEXT NOT NULL,
               PRIMARY KEY (ride_uuid, t_s)
             );
             CREATE TABLE IF NOT EXISTS pending_uploads (
               ride_uuid TEXT PRIMARY KEY,
               summary_json TEXT NOT NULL,
               fit_bytes BLOB NOT NULL,
               attempts INTEGER NOT NULL DEFAULT 0,
               next_retry_at INTEGER NOT NULL DEFAULT 0,
               last_error TEXT,
               created_at INTEGER NOT NULL
             );",
        )?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        Self::open(Path::new(":memory:"))
    }

    fn lock_conn(&self) -> anyhow::Result<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|e| anyhow::anyhow!("SQLite mutex poisoned: {e}"))
    }

    pub fn begin_ride(
        &self,
        ride_uuid: &str,
        name: &str,
        started_at: &str,
        meta_json: &str,
    ) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO active_rides (ride_uuid, name, started_at, meta_json, finished)
             VALUES (?, ?, ?, ?, 0)",
            params![ride_uuid, name, started_at, meta_json],
        )?;
        Ok(())
    }

    pub fn append_sample(&self, ride_uuid: &str, sample: &TelemetrySample) -> anyhow::Result<()> {
        let json = serde_json::to_string(sample)?;
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT OR REPLACE INTO ride_samples (ride_uuid, t_s, sample_json) VALUES (?, ?, ?)",
            params![ride_uuid, sample.t_s, json],
        )?;
        Ok(())
    }

    pub fn finish_and_queue_upload(
        &self,
        ride_uuid: &str,
        summary_json: &str,
        fit_bytes: &[u8],
        now_unix: i64,
    ) -> anyhow::Result<()> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE active_rides SET finished = 1 WHERE ride_uuid = ?",
            params![ride_uuid],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO pending_uploads
               (ride_uuid, summary_json, fit_bytes, attempts, next_retry_at, last_error, created_at)
             VALUES (?, ?, ?, 0, ?, NULL, ?)",
            params![ride_uuid, summary_json, fit_bytes, now_unix, now_unix],
        )?;
        tx.execute(
            "DELETE FROM ride_samples WHERE ride_uuid = ?",
            params![ride_uuid],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn discard_ride(&self, ride_uuid: &str) -> anyhow::Result<()> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM ride_samples WHERE ride_uuid = ?",
            params![ride_uuid],
        )?;
        tx.execute(
            "DELETE FROM active_rides WHERE ride_uuid = ?",
            params![ride_uuid],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn detect_unfinished_rides(&self) -> anyhow::Result<Vec<RecoveredActiveRide>> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            "SELECT ar.ride_uuid, ar.name, ar.started_at, COUNT(rs.t_s) AS cnt
             FROM active_rides ar
             LEFT JOIN ride_samples rs ON rs.ride_uuid = ar.ride_uuid
             WHERE ar.finished = 0
             GROUP BY ar.ride_uuid",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(RecoveredActiveRide {
                    ride_uuid: r.get(0)?,
                    name: r.get(1)?,
                    started_at: r.get(2)?,
                    sample_count: r.get(3)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    pub fn pending_upload_count(&self) -> anyhow::Result<usize> {
        let conn = self.lock_conn()?;
        let cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM pending_uploads", [], |r| r.get(0))
            .context("counting pending uploads")?;
        Ok(cnt.max(0) as usize)
    }

    pub fn next_due_upload(&self, now_unix: i64) -> anyhow::Result<Option<PendingUploadRow>> {
        let conn = self.lock_conn()?;
        let row = conn
            .query_row(
                "SELECT ride_uuid, summary_json, fit_bytes, attempts, next_retry_at
                 FROM pending_uploads
                 WHERE next_retry_at <= ?
                 ORDER BY created_at ASC
                 LIMIT 1",
                params![now_unix],
                |r| {
                    Ok(PendingUploadRow {
                        ride_uuid: r.get(0)?,
                        summary_json: r.get(1)?,
                        fit_bytes: r.get(2)?,
                        attempts: r.get(3)?,
                        next_retry_at: r.get(4)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn mark_uploaded(&self, ride_uuid: &str) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "DELETE FROM pending_uploads WHERE ride_uuid = ?",
            params![ride_uuid],
        )?;
        Ok(())
    }

    pub fn mark_upload_retry(
        &self,
        ride_uuid: &str,
        next_retry_at: i64,
        error: &str,
    ) -> anyhow::Result<()> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE pending_uploads
             SET attempts = attempts + 1, next_retry_at = ?, last_error = ?
             WHERE ride_uuid = ?",
            params![next_retry_at, error, ride_uuid],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_crash_recovery_and_upload_queue_state() -> anyhow::Result<()> {
        let store = SqliteStore::open_in_memory()?;
        store.begin_ride("uuid-1", "Test Ride", "2026-11-26T10:00:00Z", "{}")?;
        store.append_sample(
            "uuid-1",
            &TelemetrySample {
                t_s: 0,
                watts: Some(200),
                hr_bpm: Some(135),
                cadence_rpm: Some(90),
                speed_kph: Some(30.0),
                target_watts: Some(200),
                step_index: Some(0),
                erg_bias_pct: Some(100),
                synthetic_route: false,
                lat_deg: None,
                lon_deg: None,
                elevation_m: None,
                distance_m: None,
                grade_pct: None,
            },
        )?;

        let unfinished = store.detect_unfinished_rides()?;
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].sample_count, 1);

        store.finish_and_queue_upload("uuid-1", "{\"ride_uuid\":\"uuid-1\"}", &[1, 2, 3], 1000)?;
        assert_eq!(store.detect_unfinished_rides()?.len(), 0);
        assert_eq!(store.pending_upload_count()?, 1);

        let due = store.next_due_upload(1000)?;
        assert!(due.is_some());
        store.mark_upload_retry("uuid-1", 1010, "503")?;
        assert!(store.next_due_upload(1005)?.is_none());
        assert!(store.next_due_upload(1010)?.is_some());

        store.mark_uploaded("uuid-1")?;
        assert_eq!(store.pending_upload_count()?, 0);
        Ok(())
    }
}
