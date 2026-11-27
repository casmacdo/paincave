use std::path::PathBuf;
use std::sync::Arc;

use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

use paincave_bridge::storage::sqlite::SqliteStore;
use paincave_bridge::transport::TrainerTransport;
use paincave_bridge::transport::ble::{BleTransport, probe_ble_devices};
use paincave_bridge::transport::mock::MockTransport;
use paincave_bridge::uploader::UploaderConfig;
use paincave_bridge::{BridgeServiceOptions, start_bridge_service_with_options};

pub const DEFAULT_BRIDGE_PORT: u16 = 8765;

fn derive_allowed_origin(api_url: &str) -> Option<String> {
    let url = reqwest::Url::parse(api_url.trim()).ok()?;
    if matches!(url.scheme(), "http" | "https") {
        Some(url.origin().ascii_serialization())
    } else {
        None
    }
}

#[derive(Parser, Debug)]
#[command(
    name = "trainer-bridge",
    version,
    about = "PainCave Linux hardware bridge daemon"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Start the HTTP/WebSocket daemon & 1Hz workout controller on 127.0.0.1
    Serve {
        /// Use simulated MockTransport instead of Bluetooth LE
        #[arg(long, env = "PAINCAVE_MOCK_TRANSPORT", default_value_t = false)]
        mock: bool,
        /// Simulation clock speedup multiplier (e.g. 60 = 60 simulated seconds/sec)
        #[arg(long, default_value_t = 1)]
        time_scale: u32,
        /// Port to bind on 127.0.0.1
        #[arg(long, env = "PAINCAVE_BRIDGE_PORT", default_value_t = DEFAULT_BRIDGE_PORT)]
        port: u16,
        /// Cloudflare Worker API base URL
        #[arg(long, env = "PAINCAVE_API_URL", default_value = "")]
        api_url: String,
        /// Device token sent in X-Bridge-Token when uploading finished rides
        #[arg(long, env = "PAINCAVE_BRIDGE_TOKEN", default_value = "")]
        bridge_token: String,
        /// Local data directory for SQLite WAL ride log & upload queue
        #[arg(long, env = "PAINCAVE_DATA_DIR", default_value = "./.paincave-local")]
        data_dir: PathBuf,
        /// Optional comma-separated extra allowed WebSocket origins (e.g. Cloudflare Worker URL)
        #[arg(long, env = "PAINCAVE_ALLOWED_ORIGIN")]
        allowed_origin: Option<String>,
        /// Emit synthetic virtual-route GPS/elevation fields in live telemetry and FIT files
        #[arg(long, env = "PAINCAVE_SYNTHETIC_ROUTE", default_value_t = false)]
        synthetic_route: bool,
    },
    /// Scan nearby BLE devices for KICKR v5 (FTMS 0x1826) & Polar H10 (HR 0x180D)
    ProbeBle {
        #[arg(long, default_value_t = 10)]
        seconds: u64,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cli = Cli::parse();
    match cli.command {
        Commands::Serve {
            mock,
            time_scale,
            port,
            api_url,
            bridge_token,
            data_dir,
            allowed_origin,
            synthetic_route,
        } => {
            let transport: Arc<dyn TrainerTransport> = if mock {
                Arc::new(MockTransport::new())
            } else {
                Arc::new(BleTransport::new())
            };
            let allowed_origin = allowed_origin.or_else(|| derive_allowed_origin(&api_url));
            let db_path = data_dir.join("bridge.db");
            let store = SqliteStore::open(&db_path)?;
            let uploader_cfg = UploaderConfig {
                api_base_url: api_url,
                bridge_token,
                retry_base_seconds: 2,
            };

            let handle = start_bridge_service_with_options(
                transport,
                store,
                uploader_cfg,
                port,
                time_scale,
                allowed_origin,
                BridgeServiceOptions { synthetic_route },
            )
            .await?;

            tracing::info!(
                addr = %handle.local_addr,
                mock,
                time_scale,
                synthetic_route,
                "PainCave trainer-bridge listening"
            );
            tokio::signal::ctrl_c().await?;
            tracing::info!("Shutting down trainer-bridge");
            let _ = handle.shutdown_tx.send(());
        }
        Commands::ProbeBle { seconds } => {
            tracing::info!(
                seconds,
                "Scanning BlueZ adapters for FTMS trainers & BLE HR straps"
            );
            match probe_ble_devices(seconds).await {
                Ok(devices) if devices.is_empty() => {
                    println!(
                        "No FTMS (0x1826) or Heart Rate (0x180D) BLE devices found after {seconds}s."
                    );
                }
                Ok(devices) => {
                    println!("Discovered BLE cycling devices ({}):", devices.len());
                    for dev in devices {
                        let mut role_parts = Vec::new();
                        if dev.is_ftms {
                            role_parts.push("FTMS");
                        }
                        if dev.is_cps {
                            role_parts.push("CPS");
                        }
                        if dev.is_hr {
                            role_parts.push("HR");
                        }
                        let roles = if role_parts.is_empty() {
                            "OTHER".to_string()
                        } else {
                            role_parts.join("+")
                        };
                        println!(
                            "  - {} [{}] role={} connected={}",
                            dev.name, dev.address, roles, dev.connected
                        );
                    }
                }
                Err(err) => {
                    println!("BLE probe unavailable on this host: {err}");
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_BRIDGE_PORT, derive_allowed_origin};

    #[test]
    fn default_port_matches_architecture_spec() {
        assert_eq!(DEFAULT_BRIDGE_PORT, 8765);
    }

    #[test]
    fn derives_worker_origin_from_api_url() {
        assert_eq!(
            derive_allowed_origin("https://paincave.example.workers.dev"),
            Some("https://paincave.example.workers.dev".to_string())
        );
        assert_eq!(
            derive_allowed_origin("https://paincave.example.workers.dev/api/rides"),
            Some("https://paincave.example.workers.dev".to_string())
        );
    }

    #[test]
    fn rejects_empty_and_non_http_api_urls() {
        assert_eq!(derive_allowed_origin(""), None);
        assert_eq!(derive_allowed_origin("ftp://example.com"), None);
        assert_eq!(derive_allowed_origin("not a url"), None);
    }
}
