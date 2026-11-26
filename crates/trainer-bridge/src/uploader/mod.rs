use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use reqwest::multipart::{Form, Part};
use tokio::sync::Notify;

use crate::storage::sqlite::SqliteStore;

#[derive(Debug, Clone)]
pub struct UploaderConfig {
    pub api_base_url: String,
    pub bridge_token: String,
    pub retry_base_seconds: u64,
}

pub async fn process_pending_uploads_once(
    client: &reqwest::Client,
    store: &SqliteStore,
    config: &UploaderConfig,
) -> anyhow::Result<usize> {
    if config.api_base_url.trim().is_empty() || config.bridge_token.trim().is_empty() {
        return Ok(0);
    }

    let mut uploaded = 0usize;
    let url = format!("{}/api/rides", config.api_base_url.trim_end_matches('/'));

    loop {
        let now_unix = Utc::now().timestamp();
        let Some(row) = store.next_due_upload(now_unix)? else {
            break;
        };

        let fit_part = Part::bytes(row.fit_bytes)
            .file_name(format!("{}.fit", row.ride_uuid))
            .mime_str("application/vnd.ant.fit")?;

        let form = Form::new()
            .text("summary", row.summary_json)
            .part("fit", fit_part);

        let result = client
            .post(&url)
            .header("X-Bridge-Token", &config.bridge_token)
            .multipart(form)
            .send()
            .await;

        match result {
            Ok(resp) if resp.status().is_success() => {
                store.mark_uploaded(&row.ride_uuid)?;
                uploaded += 1;
                tracing::info!(ride_uuid = %row.ride_uuid, status = %resp.status(), "Uploaded ride to Cloudflare");
            }
            Ok(resp) => {
                let status = resp.status();
                let body = resp.text().await.unwrap_or_default();
                let exp = row.attempts.clamp(0, 6) as u32;
                let backoff = (config.retry_base_seconds.saturating_mul(1u64 << exp)).min(300);
                let next_retry = now_unix + (backoff as i64);
                let msg = format!("HTTP {status}: {body}");
                store.mark_upload_retry(&row.ride_uuid, next_retry, &msg)?;
                tracing::warn!(ride_uuid = %row.ride_uuid, backoff_s = backoff, error = %msg, "Upload failed, scheduled retry");
                break;
            }
            Err(err) => {
                let exp = row.attempts.clamp(0, 6) as u32;
                let backoff = (config.retry_base_seconds.saturating_mul(1u64 << exp)).min(300);
                let next_retry = now_unix + (backoff as i64);
                let msg = err.to_string();
                store.mark_upload_retry(&row.ride_uuid, next_retry, &msg)?;
                tracing::warn!(ride_uuid = %row.ride_uuid, backoff_s = backoff, error = %msg, "Upload network error, scheduled retry");
                break;
            }
        }
    }

    Ok(uploaded)
}

pub async fn run_uploader_loop(store: SqliteStore, config: UploaderConfig, notify: Arc<Notify>) {
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            tracing::error!(error = %err, "Failed to initialize HTTP client for uploader");
            return;
        }
    };

    loop {
        if let Err(err) = process_pending_uploads_once(&client, &store, &config).await {
            tracing::error!(error = %err, "Uploader pass error");
        }
        tokio::select! {
            _ = notify.notified() => {}
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}
