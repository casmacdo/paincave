use serde::{Deserialize, Serialize};

pub use crate::route::{RoutePayload, RoutePoint};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkoutStepMode {
    Erg,
    Slope,
    Resistance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SensorConnectionState {
    Disconnected,
    Scanning,
    Connecting,
    Connected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkoutExecutionState {
    Idle,
    Armed,
    Running,
    Paused,
    AutoPaused,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadStatus {
    Queued,
    Uploaded,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntervalStatus {
    Completed,
    Partial,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FlattenedStep {
    pub step_index: usize,
    pub label: String,
    pub start_offset_s: u32,
    pub duration_s: u32,
    pub mode: WorkoutStepMode,
    pub watts_start: Option<u16>,
    pub watts_end: Option<u16>,
    pub grade_pct: Option<f64>,
    pub resistance_pct: Option<f64>,
    pub cadence_rpm: Option<u16>,
    pub text_cue: Option<String>,
    pub is_work_interval: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BridgeCommand {
    ScanSensors,
    LoadWorkout {
        #[serde(default)]
        workout_id: Option<String>,
        #[serde(default)]
        planned_session_id: Option<String>,
        name: String,
        ftp_watts: u16,
        #[serde(default)]
        lthr_bpm: Option<u16>,
        #[serde(default)]
        hrmax_bpm: Option<u16>,
        #[serde(default)]
        weight_kg: Option<f64>,
        steps: Vec<FlattenedStep>,
        #[serde(default)]
        route: Option<RoutePayload>,
    },
    LoadRoute {
        name: String,
        ftp_watts: u16,
        #[serde(default)]
        lthr_bpm: Option<u16>,
        #[serde(default)]
        hrmax_bpm: Option<u16>,
        #[serde(default)]
        weight_kg: Option<f64>,
        route: RoutePayload,
    },
    Start,
    Pause,
    Resume,
    SkipStep,
    PrevStep,
    ExtendStep {
        seconds: i32,
    },
    SetErgBias {
        bias_pct: u16,
    },
    SetManualTarget {
        mode: WorkoutStepMode,
        #[serde(default)]
        watts: Option<u16>,
        #[serde(default)]
        grade_pct: Option<f64>,
        #[serde(default)]
        resistance_pct: Option<f64>,
    },
    StopAndSave {
        #[serde(default)]
        rpe: Option<u8>,
        #[serde(default)]
        feel: Option<u8>,
        #[serde(default)]
        notes: Option<String>,
    },
    Discard,
    InjectMockFault {
        cadence_zero_seconds: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SensorStatus {
    pub trainer: SensorConnectionState,
    pub hr: SensorConnectionState,
    pub transport: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LiveHistoryPoint {
    pub t_s: u32,
    pub watts: Option<u16>,
    pub target_watts: Option<u16>,
    pub hr_bpm: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum BridgeEvent {
    Telemetry {
        ts_ms: i64,
        ride_uuid: Option<String>,
        workout_name: Option<String>,
        state: WorkoutExecutionState,
        elapsed_s: u32,
        step_index: usize,
        total_steps: usize,
        step_label: Option<String>,
        step_elapsed_s: u32,
        step_remaining_s: u32,
        mode: WorkoutStepMode,
        target_watts: Option<u16>,
        target_grade_pct: Option<f64>,
        erg_bias_pct: u16,
        #[serde(default)]
        target_cadence_rpm: Option<u16>,
        watts: Option<u16>,
        watts_3s: Option<u16>,
        cadence_rpm: Option<u8>,
        hr_bpm: Option<u8>,
        speed_kph: Option<f64>,
        #[serde(default)]
        synthetic_route: bool,
        #[serde(default)]
        lat_deg: Option<f64>,
        #[serde(default)]
        lon_deg: Option<f64>,
        #[serde(default)]
        elevation_m: Option<f64>,
        #[serde(default)]
        distance_m: Option<f64>,
        #[serde(default)]
        grade_pct: Option<f64>,
        text_cue: Option<String>,
        sensors: SensorStatus,
        pending_uploads: usize,
    },
    SessionState {
        workout_name: Option<String>,
        steps: Vec<FlattenedStep>,
        #[serde(default)]
        route: Option<RoutePayload>,
        #[serde(default)]
        history: Vec<LiveHistoryPoint>,
    },
    RideSaved {
        ride_uuid: String,
        upload_status: UploadStatus,
        fit_bytes: usize,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TelemetrySample {
    pub t_s: u32,
    pub watts: Option<u16>,
    pub hr_bpm: Option<u8>,
    pub cadence_rpm: Option<u8>,
    #[serde(default)]
    pub speed_kph: Option<f64>,
    #[serde(default)]
    pub target_watts: Option<u16>,
    #[serde(default)]
    pub step_index: Option<usize>,
    #[serde(default)]
    pub erg_bias_pct: Option<u16>,
    #[serde(default)]
    pub synthetic_route: bool,
    #[serde(default)]
    pub lat_deg: Option<f64>,
    #[serde(default)]
    pub lon_deg: Option<f64>,
    #[serde(default)]
    pub elevation_m: Option<f64>,
    #[serde(default)]
    pub distance_m: Option<f64>,
    #[serde(default)]
    pub grade_pct: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AthleteThresholds {
    pub ftp_watts: u16,
    #[serde(default)]
    pub lthr_bpm: Option<u16>,
    #[serde(default)]
    pub hrmax_bpm: Option<u16>,
    #[serde(default)]
    pub weight_kg: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PowerZoneSeconds {
    pub z1: u32,
    pub z2: u32,
    pub z3: u32,
    pub z4: u32,
    pub z5: u32,
    pub z6: u32,
    pub z7: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct HrZoneSeconds {
    pub z1: u32,
    pub z2: u32,
    pub z3: u32,
    pub z4: u32,
    pub z5: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct QualityFlags {
    pub power_dropouts_s: u32,
    pub hr_dropouts_s: u32,
    pub erg_smoothing_detected: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IntervalExecution {
    pub step_index: usize,
    pub label: String,
    pub mode: WorkoutStepMode,
    pub is_work_interval: bool,
    pub planned_duration_s: u32,
    pub actual_duration_s: u32,
    pub target_watts: Option<u16>,
    pub actual_avg_watts: Option<u16>,
    pub pct_of_target: Option<f64>,
    pub avg_hr: Option<u16>,
    pub max_hr: Option<u16>,
    pub hr_drift_bpm: Option<i32>,
    pub avg_cadence: Option<u16>,
    pub erg_bias_pct: u16,
    pub status: IntervalStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MmpPoint {
    pub duration_s: u32,
    pub watts: u16,
    pub w_per_kg: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RideUploadSummary {
    pub ride_uuid: String,
    pub name: String,
    pub source: String,
    pub workout_id: Option<String>,
    pub planned_session_id: Option<String>,
    pub started_at: String,
    pub ride_day: String,

    pub duration_s: u32,
    pub elapsed_s: u32,
    pub work_kj: f64,
    pub avg_power: Option<u16>,
    pub np_watts: Option<u16>,
    pub intensity_factor: Option<f64>,
    pub tss: f64,
    pub variability_index: Option<f64>,
    pub avg_hr: Option<u16>,
    pub max_hr: Option<u16>,
    pub efficiency_factor: Option<f64>,
    pub pw_hr_decoupling: Option<f64>,
    pub hrr_60s: Option<i32>,
    pub time_gt_90_hrmax_s: u32,
    pub avg_cadence: Option<u16>,
    pub compliance_pct: Option<f64>,

    pub power_zones: PowerZoneSeconds,
    pub hr_zones: HrZoneSeconds,
    pub quality_flags: QualityFlags,

    pub ftp_snapshot: u16,
    pub lthr_snapshot: Option<u16>,
    pub hrmax_snapshot: Option<u16>,
    pub weight_kg_snapshot: Option<f64>,

    pub rpe: Option<u8>,
    pub feel: Option<u8>,
    pub notes: String,

    pub intervals: Vec<IntervalExecution>,
    pub peaks: Vec<MmpPoint>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_telemetry_json_deserializes_with_default_route_fields() -> anyhow::Result<()> {
        let sample: TelemetrySample = serde_json::from_str(
            r#"{"t_s":12,"watts":200,"hr_bpm":145,"cadence_rpm":90,"speed_kph":32.4}"#,
        )?;

        assert!(!sample.synthetic_route);
        assert_eq!(sample.lat_deg, None);
        assert_eq!(sample.lon_deg, None);
        assert_eq!(sample.elevation_m, None);
        assert_eq!(sample.distance_m, None);
        assert_eq!(sample.grade_pct, None);
        Ok(())
    }
}
