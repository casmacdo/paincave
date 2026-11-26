pub mod ble;
pub mod ble_parse;
pub mod mock;

use async_trait::async_trait;

use crate::protocol::SensorStatus;

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct RawSensorSample {
    pub watts: Option<u16>,
    pub hr_bpm: Option<u8>,
    pub cadence_rpm: Option<u8>,
    pub speed_kph: Option<f64>,
}

#[async_trait]
pub trait TrainerTransport: Send + Sync {
    fn transport_name(&self) -> &'static str;

    async fn read_sample(&self) -> (RawSensorSample, SensorStatus);

    async fn set_erg_watts(&self, watts: u16) -> anyhow::Result<()>;

    async fn set_slope_grade(&self, grade_pct: f64) -> anyhow::Result<()>;

    async fn set_resistance_pct(&self, pct: f64) -> anyhow::Result<()>;

    async fn scan_sensors(&self) -> anyhow::Result<()>;

    async fn inject_fault_cadence_zero(&self, _seconds: u32) -> anyhow::Result<()> {
        Ok(())
    }

    async fn advance_simulated_second(&self) {}
}
