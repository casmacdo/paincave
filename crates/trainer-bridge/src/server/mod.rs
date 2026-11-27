use std::sync::Arc;

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::{broadcast, mpsc};
use tower_http::cors::{Any, CorsLayer};

use crate::protocol::{BridgeCommand, BridgeEvent, SensorStatus, WorkoutExecutionState};
use crate::storage::sqlite::SqliteStore;
use crate::transport::TrainerTransport;

#[derive(Clone)]
pub struct BridgeServerState {
    pub command_tx: mpsc::Sender<BridgeCommand>,
    pub event_tx: broadcast::Sender<BridgeEvent>,
    pub transport: Arc<dyn TrainerTransport>,
    pub store: SqliteStore,
    pub allowed_origin: Option<String>,
    pub current_state: Arc<tokio::sync::RwLock<WorkoutExecutionState>>,
    pub latest_session: Arc<tokio::sync::RwLock<BridgeEvent>>,
    pub latest_telemetry: Arc<tokio::sync::RwLock<Option<BridgeEvent>>>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
    transport: String,
    trainer: crate::protocol::SensorConnectionState,
    hr: crate::protocol::SensorConnectionState,
    workout_state: WorkoutExecutionState,
    pending_uploads: usize,
}

fn is_origin_allowed(origin: Option<&str>, extra_allowed: Option<&str>) -> bool {
    let Some(raw) = origin else {
        // Non-browser local clients (CLI / automated drivers) may omit Origin
        return true;
    };
    if raw.starts_with("http://localhost:")
        || raw == "http://localhost"
        || raw.starts_with("http://127.0.0.1:")
        || raw == "http://127.0.0.1"
        || raw.starts_with("https://localhost:")
        || raw == "https://localhost"
    {
        return true;
    }
    if let Some(allowed) = extra_allowed
        && !allowed.trim().is_empty()
    {
        return allowed
            .split(',')
            .map(str::trim)
            .any(|item| !item.is_empty() && item == raw);
    }
    false
}

pub fn build_router(state: BridgeServerState) -> Router {
    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any);
    Router::new()
        .route("/health", get(health_handler))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state)
}

async fn health_handler(State(state): State<BridgeServerState>) -> Json<HealthResponse> {
    let (_, sensors): (_, SensorStatus) = state.transport.read_sample().await;
    let workout_state = *state.current_state.read().await;
    let pending_uploads = state.store.pending_upload_count().unwrap_or(0);

    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        transport: sensors.transport,
        trainer: sensors.trainer,
        hr: sensors.hr,
        workout_state,
        pending_uploads,
    })
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(state): State<BridgeServerState>,
) -> Response {
    let origin = headers
        .get(axum::http::header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !is_origin_allowed(origin, state.allowed_origin.as_deref()) {
        return (StatusCode::FORBIDDEN, "Origin not allowed").into_response();
    }
    ws.on_upgrade(move |socket| handle_ws_connection(socket, state))
}

async fn handle_ws_connection(socket: WebSocket, state: BridgeServerState) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let mut event_rx = state.event_tx.subscribe();
    let initial_session = state.latest_session.read().await.clone();
    let initial_telemetry = state.latest_telemetry.read().await.clone();

    let send_task = tokio::spawn(async move {
        if let Ok(text) = serde_json::to_string(&initial_session)
            && ws_tx.send(Message::Text(text.into())).await.is_err()
        {
            return;
        }
        if let Some(tel) = initial_telemetry
            && let Ok(text) = serde_json::to_string(&tel)
            && ws_tx.send(Message::Text(text.into())).await.is_err()
        {
            return;
        }
        while let Ok(ev) = event_rx.recv().await {
            let Ok(text) = serde_json::to_string(&ev) else {
                continue;
            };
            if ws_tx.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Text(text) => match serde_json::from_str::<BridgeCommand>(&text) {
                Ok(cmd) => {
                    if state.command_tx.send(cmd).await.is_err() {
                        break;
                    }
                }
                Err(err) => {
                    let _ = state.event_tx.send(BridgeEvent::Error {
                        code: "INVALID_COMMAND".to_string(),
                        message: err.to_string(),
                    });
                }
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    send_task.abort();
}
