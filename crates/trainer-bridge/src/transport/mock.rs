use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::protocol::{SensorConnectionState, SensorStatus, WorkoutStepMode};
use crate::transport::{RawSensorSample, TrainerTransport};

#[derive(Debug)]
struct MockState {
    mode: WorkoutStepMode,
    target_watts: u16,
    target_grade_pct: f64,
    resistance_pct: f64,
    current_watts: f64,
    current_hr: f64,
    tick: u32,
    cadence_zero_ticks_remaining: u32,
}

impl Default for MockState {
    fn default() -> Self {
        Self {
            mode: WorkoutStepMode::Erg,
            target_watts: 140,
            target_grade_pct: 0.0,
            resistance_pct: 20.0,
            current_watts: 130.0,
            current_hr: 112.0,
            tick: 0,
            cadence_zero_ticks_remaining: 0,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct MockTransport {
    state: Arc<Mutex<MockState>>,
}

impl MockTransport {
    pub fn new() -> Self {
        Self::default()
    }
}

#[async_trait]
impl TrainerTransport for MockTransport {
    fn transport_name(&self) -> &'static str {
        "mock"
    }

    async fn read_sample(&self) -> (RawSensorSample, SensorStatus) {
        let guard = self.state.lock().await;
        let cadence = if guard.cadence_zero_ticks_remaining > 0 {
            0
        } else {
            let wobble = ((guard.tick % 5) as i16 - 2) as i16;
            (90 + wobble).clamp(60, 120) as u8
        };

        let watts = if cadence == 0 {
            0
        } else {
            let noise = ((guard.tick * 7) % 9) as f64 - 4.0;
            (guard.current_watts + noise).max(0.0).round() as u16
        };

        let hr = guard.current_hr.clamp(55.0, 205.0).round() as u8;
        let speed_kph = if cadence == 0 {
            0.0
        } else {
            ((20.0 + (f64::from(watts) / 280.0) * 18.0) * 10.0).round() / 10.0
        };

        let sample = RawSensorSample {
            watts: Some(watts),
            hr_bpm: Some(hr),
            cadence_rpm: Some(cadence),
            speed_kph: Some(speed_kph),
        };
        let status = SensorStatus {
            trainer: SensorConnectionState::Connected,
            hr: SensorConnectionState::Connected,
            transport: "mock".to_string(),
        };
        (sample, status)
    }

    async fn set_erg_watts(&self, watts: u16) -> anyhow::Result<()> {
        let mut guard = self.state.lock().await;
        guard.mode = WorkoutStepMode::Erg;
        guard.target_watts = watts;
        Ok(())
    }

    async fn set_slope_grade(&self, grade_pct: f64) -> anyhow::Result<()> {
        let mut guard = self.state.lock().await;
        guard.mode = WorkoutStepMode::Slope;
        guard.target_grade_pct = grade_pct;
        Ok(())
    }

    async fn set_resistance_pct(&self, pct: f64) -> anyhow::Result<()> {
        let mut guard = self.state.lock().await;
        guard.mode = WorkoutStepMode::Resistance;
        guard.resistance_pct = pct;
        Ok(())
    }

    async fn scan_sensors(&self) -> anyhow::Result<()> {
        Ok(())
    }

    async fn inject_fault_cadence_zero(&self, seconds: u32) -> anyhow::Result<()> {
        let mut guard = self.state.lock().await;
        guard.cadence_zero_ticks_remaining = seconds;
        Ok(())
    }

    async fn advance_simulated_second(&self) {
        let mut guard = self.state.lock().await;
        guard.tick = guard.tick.saturating_add(1);

        let desired_watts = if guard.cadence_zero_ticks_remaining > 0 {
            guard.cadence_zero_ticks_remaining -= 1;
            0.0
        } else {
            match guard.mode {
                WorkoutStepMode::Erg => f64::from(guard.target_watts),
                WorkoutStepMode::Slope => (180.0 + guard.target_grade_pct * 18.0).max(80.0),
                WorkoutStepMode::Resistance => (80.0 + guard.resistance_pct * 3.0).max(60.0),
            }
        };

        // First-order KICKR flywheel lag (~2s tau)
        guard.current_watts += (desired_watts - guard.current_watts) * 0.55;

        // First-order HR kinetics
        let target_hr = 96.0 + (guard.current_watts / 260.0) * 68.0;
        let hr_alpha = if target_hr > guard.current_hr {
            1.0 / 26.0
        } else {
            1.0 / 32.0
        };
        guard.current_hr += (target_hr - guard.current_hr) * hr_alpha;
    }
}
