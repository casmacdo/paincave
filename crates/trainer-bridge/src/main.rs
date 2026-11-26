//! PainCave Linux Trainer Bridge Daemon
//!
//! Responsibilities (built across M4 & M6):
//! - Hardware abstraction via `TrainerTransport` (`MockTransport`, `BleTransport`, optional `AntTransport`)
//! - Monotonic 1Hz workout execution engine + ERG spiral-of-death guard
//! - Crash-safe local SQLite WAL recording + FIT v2.0 encoding + idempotent Cloudflare upload
//! - Local HTTP `/health` and WebSocket `/ws` server on `127.0.0.1:8765`

pub const DEFAULT_BRIDGE_PORT: u16 = 8765;

fn main() {
    println!(
        "paincave trainer-bridge v{} (bootstrap skeleton; implement M4-01 next)",
        env!("CARGO_PKG_VERSION")
    );
}

#[cfg(test)]
mod tests {
    use super::DEFAULT_BRIDGE_PORT;

    #[test]
    fn default_port_matches_architecture_spec() {
        assert_eq!(DEFAULT_BRIDGE_PORT, 8765);
    }
}
