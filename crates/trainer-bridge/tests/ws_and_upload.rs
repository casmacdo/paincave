use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::extract::{Multipart, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use paincave_bridge::protocol::{BridgeCommand, BridgeEvent, FlattenedStep, WorkoutStepMode};
use paincave_bridge::start_bridge_service;
use paincave_bridge::storage::sqlite::SqliteStore;
use paincave_bridge::transport::mock::MockTransport;
use paincave_bridge::uploader::UploaderConfig;

#[derive(Clone, Default)]
struct MockCloudState {
    attempts: Arc<AtomicUsize>,
    uploaded_ride_uuid: Arc<Mutex<Option<String>>>,
    uploaded_fit_len: Arc<Mutex<usize>>,
}

async fn mock_ingest_ride(
    State(state): State<MockCloudState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> (StatusCode, Json<serde_json::Value>) {
    let token = headers
        .get("X-Bridge-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if token != "test-bridge-secret" {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "unauthorized" })),
        );
    }

    let attempt = state.attempts.fetch_add(1, Ordering::SeqCst);
    if attempt == 0 {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({ "error": "simulated transient 503" })),
        );
    }

    while let Ok(Some(field)) = multipart.next_field().await {
        match field.name() {
            Some("summary") => {
                if let Ok(text) = field.text().await
                    && let Ok(val) = serde_json::from_str::<serde_json::Value>(&text)
                    && let Some(uuid) = val.get("ride_uuid").and_then(|v| v.as_str())
                {
                    *state.uploaded_ride_uuid.lock().await = Some(uuid.to_string());
                }
            }
            Some("fit") => {
                if let Ok(bytes) = field.bytes().await {
                    *state.uploaded_fit_len.lock().await = bytes.len();
                }
            }
            _ => {}
        }
    }

    (StatusCode::CREATED, Json(serde_json::json!({ "ok": true })))
}

#[tokio::test]
async fn websocket_workout_control_and_upload_retry_recovery() -> anyhow::Result<()> {
    // 1. Start mock Cloudflare ingest server that fails attempt #1 with 503 and succeeds on retry
    let cloud_state = MockCloudState::default();
    let cloud_router = Router::new()
        .route("/api/rides", post(mock_ingest_ride))
        .with_state(cloud_state.clone());
    let cloud_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let cloud_addr = cloud_listener.local_addr()?;
    tokio::spawn(async move {
        let _ = axum::serve(cloud_listener, cloud_router).await;
    });

    // 2. Start trainer-bridge on ephemeral port with 60x mock time scale
    let store = SqliteStore::open_in_memory()?;
    let transport = Arc::new(MockTransport::new());
    let handle = start_bridge_service(
        transport,
        store.clone(),
        UploaderConfig {
            api_base_url: format!("http://{cloud_addr}"),
            bridge_token: "test-bridge-secret".to_string(),
            retry_base_seconds: 1,
        },
        0,
        60,
        None,
    )
    .await?;

    // 3. Verify /health endpoint
    let health_resp = reqwest::get(format!("http://{}/health", handle.local_addr)).await?;
    assert_eq!(health_resp.status(), 200);
    let health_json: serde_json::Value = health_resp.json().await?;
    assert_eq!(
        health_json.get("status").and_then(|v| v.as_str()),
        Some("ok")
    );

    // 4. Connect over WebSocket, load & run workout, save, and verify retryable upload succeeds
    let ws_url = format!("ws://{}/ws", handle.local_addr);
    let (mut ws, _) = tokio_tungstenite::connect_async(&ws_url).await?;

    let load = BridgeCommand::LoadWorkout {
        workout_id: Some("w-test".to_string()),
        planned_session_id: None,
        name: "WS Integration Ride".to_string(),
        ftp_watts: 250,
        lthr_bpm: Some(170),
        hrmax_bpm: Some(190),
        weight_kg: Some(72.0),
        steps: vec![FlattenedStep {
            step_index: 0,
            label: "Short Steady".to_string(),
            start_offset_s: 0,
            duration_s: 20,
            mode: WorkoutStepMode::Erg,
            watts_start: Some(200),
            watts_end: Some(200),
            grade_pct: None,
            resistance_pct: None,
            cadence_rpm: Some(90),
            text_cue: None,
            is_work_interval: true,
        }],
    };
    ws.send(Message::Text(serde_json::to_string(&load)?.into()))
        .await?;
    ws.send(Message::Text(
        serde_json::to_string(&BridgeCommand::Start)?.into(),
    ))
    .await?;

    // Wait for >= 15 simulated seconds of telemetry (at 60x, ~300ms)
    let mut saw_running_elapsed = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline {
        if let Some(Ok(Message::Text(txt))) = ws.next().await
            && let Ok(BridgeEvent::Telemetry { elapsed_s, .. }) =
                serde_json::from_str::<BridgeEvent>(&txt)
            && elapsed_s >= 12
        {
            saw_running_elapsed = true;
            break;
        }
    }
    assert!(saw_running_elapsed);

    ws.send(Message::Text(
        serde_json::to_string(&BridgeCommand::StopAndSave {
            rpe: Some(6),
            feel: Some(4),
            notes: Some("WS test complete".to_string()),
        })?
        .into(),
    ))
    .await?;

    let mut ride_saved_uuid = None;
    let save_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while tokio::time::Instant::now() < save_deadline {
        if let Some(Ok(Message::Text(txt))) = ws.next().await
            && let Ok(BridgeEvent::RideSaved {
                ride_uuid,
                fit_bytes,
                ..
            }) = serde_json::from_str::<BridgeEvent>(&txt)
        {
            assert!(fit_bytes > 100);
            ride_saved_uuid = Some(ride_uuid);
            break;
        }
    }
    let expected_uuid =
        ride_saved_uuid.ok_or_else(|| anyhow::anyhow!("Missing RideSaved event"))?;

    // Wait up to 8s for attempt #1 (503) + retry #2 (201)
    let upload_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    while tokio::time::Instant::now() < upload_deadline {
        if cloud_state.uploaded_ride_uuid.lock().await.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    assert!(cloud_state.attempts.load(Ordering::SeqCst) >= 2);
    assert_eq!(
        cloud_state.uploaded_ride_uuid.lock().await.as_deref(),
        Some(expected_uuid.as_str())
    );
    assert!(*cloud_state.uploaded_fit_len.lock().await > 100);
    assert_eq!(store.pending_upload_count()?, 0);

    let _ = handle.shutdown_tx.send(());
    Ok(())
}
