pub mod engine;
pub mod fit;
pub mod physiology;
pub mod protocol;
pub mod route;
pub mod server;
pub mod storage;
pub mod transport;
pub mod uploader;

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{Notify, RwLock, broadcast, mpsc};

use crate::engine::workout::WorkoutEngine;
use crate::protocol::{BridgeCommand, BridgeEvent, WorkoutExecutionState};
use crate::server::{BridgeServerState, build_router};
use crate::storage::sqlite::SqliteStore;
use crate::transport::TrainerTransport;
use crate::uploader::{UploaderConfig, run_uploader_loop};

pub struct RunningBridgeHandle {
    pub local_addr: std::net::SocketAddr,
    pub shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

#[derive(Debug, Clone, Default)]
pub struct BridgeServiceOptions {
    pub synthetic_route: bool,
}

pub async fn start_bridge_service(
    transport: Arc<dyn TrainerTransport>,
    store: SqliteStore,
    uploader_config: UploaderConfig,
    port: u16,
    time_scale: u32,
    allowed_origin: Option<String>,
) -> anyhow::Result<RunningBridgeHandle> {
    start_bridge_service_with_options(
        transport,
        store,
        uploader_config,
        port,
        time_scale,
        allowed_origin,
        BridgeServiceOptions::default(),
    )
    .await
}

pub async fn start_bridge_service_with_options(
    transport: Arc<dyn TrainerTransport>,
    store: SqliteStore,
    uploader_config: UploaderConfig,
    port: u16,
    time_scale: u32,
    allowed_origin: Option<String>,
    options: BridgeServiceOptions,
) -> anyhow::Result<RunningBridgeHandle> {
    let unfinished = store.detect_unfinished_rides()?;
    for ride in &unfinished {
        tracing::warn!(
            ride_uuid = %ride.ride_uuid,
            name = %ride.name,
            samples = ride.sample_count,
            "Detected unfinished ride in local crash-recovery DB"
        );
    }

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<BridgeCommand>(64);
    let (event_tx, _) = broadcast::channel::<BridgeEvent>(128);
    let upload_notify = Arc::new(Notify::new());
    let current_state = Arc::new(RwLock::new(WorkoutExecutionState::Idle));

    let uploader_store = store.clone();
    let uploader_notify = Arc::clone(&upload_notify);
    tokio::spawn(async move {
        run_uploader_loop(uploader_store, uploader_config, uploader_notify).await;
    });

    let mut engine = WorkoutEngine::new(Arc::clone(&transport), store.clone(), upload_notify)
        .with_synthetic_route(options.synthetic_route);
    let latest_session = Arc::new(RwLock::new(engine.session_state_event()));
    let latest_telemetry = Arc::new(RwLock::new(None));
    let engine_event_tx = event_tx.clone();
    let engine_state = Arc::clone(&current_state);
    let engine_latest_session = Arc::clone(&latest_session);
    let engine_latest_telemetry = Arc::clone(&latest_telemetry);
    let tick_ms = (1000 / u64::from(time_scale.max(1))).max(5);

    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(tick_ms));
        loop {
            tokio::select! {
                Some(cmd) = cmd_rx.recv() => {
                    let events = engine.handle_command(cmd).await;
                    *engine_state.write().await = engine.state();
                    *engine_latest_session.write().await = engine.session_state_event();
                    for ev in events {
                        let _ = engine_event_tx.send(ev);
                    }
                }
                _ = ticker.tick() => {
                    let ev = engine.tick_one_second().await;
                    *engine_state.write().await = engine.state();
                    *engine_latest_telemetry.write().await = Some(ev.clone());
                    if engine.state() != WorkoutExecutionState::Idle {
                        *engine_latest_session.write().await = engine.session_state_event();
                    }
                    let _ = engine_event_tx.send(ev);
                }
            }
        }
    });

    let server_state = BridgeServerState {
        command_tx: cmd_tx,
        event_tx,
        transport,
        store,
        allowed_origin,
        current_state,
        latest_session,
        latest_telemetry,
    };

    let router = build_router(server_state);
    let bind_addr = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(&bind_addr).await?;
    let local_addr = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    tokio::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(err) = server.await {
            tracing::error!(error = %err, "Axum bridge server exited with error");
        }
    });

    Ok(RunningBridgeHandle {
        local_addr,
        shutdown_tx,
    })
}
