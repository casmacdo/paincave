use std::collections::VecDeque;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use tokio::sync::Notify;
use uuid::Uuid;

use crate::engine::erg_guard::{ErgGuard, ErgGuardOutcome};
use crate::fit::encoder::encode_cycling_fit;
use crate::physiology::compute_ride_metrics;
use crate::protocol::{
    BridgeCommand, BridgeEvent, FlattenedStep, RideUploadSummary, TelemetrySample, UploadStatus,
    WorkoutExecutionState, WorkoutStepMode,
};
use crate::route::{SyntheticRoute, SyntheticRoutePosition};
use crate::storage::sqlite::SqliteStore;
use crate::transport::TrainerTransport;

#[derive(Debug, Clone)]
struct ActiveWorkoutMeta {
    workout_id: Option<String>,
    planned_session_id: Option<String>,
    name: String,
    ftp_watts: u16,
    lthr_bpm: Option<u16>,
    hrmax_bpm: Option<u16>,
    weight_kg: Option<f64>,
}

impl Default for ActiveWorkoutMeta {
    fn default() -> Self {
        Self {
            workout_id: None,
            planned_session_id: None,
            name: "Free Ride".to_string(),
            ftp_watts: 250,
            lthr_bpm: Some(170),
            hrmax_bpm: Some(190),
            weight_kg: None,
        }
    }
}

pub struct WorkoutEngine {
    transport: Arc<dyn TrainerTransport>,
    store: SqliteStore,
    upload_notify: Arc<Notify>,
    state: WorkoutExecutionState,
    ride_uuid: Option<String>,
    started_at: Option<DateTime<Utc>>,
    meta: ActiveWorkoutMeta,
    steps: Vec<FlattenedStep>,
    step_index: usize,
    step_elapsed_s: u32,
    elapsed_s: u32,
    erg_bias_pct: u16,
    manual_mode_override: Option<WorkoutStepMode>,
    manual_watts_override: Option<u16>,
    manual_grade_override: Option<f64>,
    manual_resistance_override: Option<f64>,
    last_sent_mode: Option<WorkoutStepMode>,
    last_sent_watts: Option<u16>,
    last_sent_grade: Option<f64>,
    last_sent_resistance: Option<f64>,
    erg_guard: ErgGuard,
    samples: Vec<TelemetrySample>,
    watts_window_3s: VecDeque<u16>,
    synthetic_route_enabled: bool,
    synthetic_route: SyntheticRoute,
    last_route_position: Option<SyntheticRoutePosition>,
}

impl WorkoutEngine {
    pub fn new(
        transport: Arc<dyn TrainerTransport>,
        store: SqliteStore,
        upload_notify: Arc<Notify>,
    ) -> Self {
        Self {
            transport,
            store,
            upload_notify,
            state: WorkoutExecutionState::Idle,
            ride_uuid: None,
            started_at: None,
            meta: ActiveWorkoutMeta::default(),
            steps: Vec::new(),
            step_index: 0,
            step_elapsed_s: 0,
            elapsed_s: 0,
            erg_bias_pct: 100,
            manual_mode_override: None,
            manual_watts_override: None,
            manual_grade_override: None,
            manual_resistance_override: None,
            last_sent_mode: None,
            last_sent_watts: None,
            last_sent_grade: None,
            last_sent_resistance: None,
            erg_guard: ErgGuard::new(),
            samples: Vec::new(),
            watts_window_3s: VecDeque::with_capacity(3),
            synthetic_route_enabled: false,
            synthetic_route: SyntheticRoute::default(),
            last_route_position: None,
        }
    }

    pub fn with_synthetic_route(mut self, enabled: bool) -> Self {
        self.synthetic_route_enabled = enabled;
        self
    }

    pub fn state(&self) -> WorkoutExecutionState {
        self.state
    }

    pub fn elapsed_s(&self) -> u32 {
        self.elapsed_s
    }

    fn reset_session(&mut self) {
        self.ride_uuid = None;
        self.started_at = None;
        self.step_index = 0;
        self.step_elapsed_s = 0;
        self.elapsed_s = 0;
        self.erg_bias_pct = 100;
        self.manual_mode_override = None;
        self.manual_watts_override = None;
        self.manual_grade_override = None;
        self.manual_resistance_override = None;
        self.last_sent_mode = None;
        self.last_sent_watts = None;
        self.last_sent_grade = None;
        self.last_sent_resistance = None;
        self.erg_guard.reset();
        self.samples.clear();
        self.synthetic_route.reset();
        self.last_route_position = None;
    }

    fn current_step(&self) -> Option<&FlattenedStep> {
        self.steps.get(self.step_index)
    }

    fn compute_desired_target(&self) -> (WorkoutStepMode, Option<u16>, Option<f64>, Option<f64>) {
        if let Some(mode) = self.manual_mode_override {
            return match mode {
                WorkoutStepMode::Erg => {
                    let base = self.manual_watts_override.unwrap_or(150);
                    let biased = ((u32::from(base) * u32::from(self.erg_bias_pct)) / 100) as u16;
                    (WorkoutStepMode::Erg, Some(biased), None, None)
                }
                WorkoutStepMode::Slope => (
                    WorkoutStepMode::Slope,
                    None,
                    Some(self.manual_grade_override.unwrap_or(0.0)),
                    None,
                ),
                WorkoutStepMode::Resistance => (
                    WorkoutStepMode::Resistance,
                    None,
                    None,
                    Some(self.manual_resistance_override.unwrap_or(20.0)),
                ),
            };
        }

        let Some(step) = self.current_step() else {
            return (WorkoutStepMode::Erg, Some(120), None, None);
        };

        match step.mode {
            WorkoutStepMode::Erg => {
                let w_start = step.watts_start.unwrap_or(120);
                let w_end = step.watts_end.unwrap_or(w_start);
                let denom = step.duration_s.saturating_sub(1).max(1);
                let frac = if step.duration_s <= 1 {
                    0.0
                } else {
                    (f64::from(self.step_elapsed_s) / f64::from(denom)).clamp(0.0, 1.0)
                };
                let raw_w =
                    (f64::from(w_start) + (f64::from(w_end) - f64::from(w_start)) * frac).round();
                let biased = ((raw_w * f64::from(self.erg_bias_pct)) / 100.0).round() as u16;
                (WorkoutStepMode::Erg, Some(biased), None, None)
            }
            WorkoutStepMode::Slope => (
                WorkoutStepMode::Slope,
                None,
                Some(step.grade_pct.unwrap_or(0.0)),
                None,
            ),
            WorkoutStepMode::Resistance => (
                WorkoutStepMode::Resistance,
                None,
                None,
                Some(step.resistance_pct.unwrap_or(20.0)),
            ),
        }
    }

    async fn apply_trainer_command(
        &mut self,
        mode: WorkoutStepMode,
        watts: Option<u16>,
        grade: Option<f64>,
        resistance: Option<f64>,
    ) {
        match mode {
            WorkoutStepMode::Erg => {
                let target = watts.unwrap_or(100);
                if self.last_sent_mode != Some(WorkoutStepMode::Erg)
                    || self.last_sent_watts != Some(target)
                {
                    if let Err(err) = self.transport.set_erg_watts(target).await {
                        tracing::warn!(error = %err, "Failed to send ERG target to trainer");
                    } else {
                        self.last_sent_mode = Some(WorkoutStepMode::Erg);
                        self.last_sent_watts = Some(target);
                        self.last_sent_grade = None;
                        self.last_sent_resistance = None;
                    }
                }
            }
            WorkoutStepMode::Slope => {
                let g = grade.unwrap_or(0.0);
                if self.last_sent_mode != Some(WorkoutStepMode::Slope)
                    || self.last_sent_grade != Some(g)
                {
                    if let Err(err) = self.transport.set_slope_grade(g).await {
                        tracing::warn!(error = %err, "Failed to send slope grade to trainer");
                    } else {
                        self.last_sent_mode = Some(WorkoutStepMode::Slope);
                        self.last_sent_grade = Some(g);
                        self.last_sent_watts = None;
                        self.last_sent_resistance = None;
                    }
                }
            }
            WorkoutStepMode::Resistance => {
                let r = resistance.unwrap_or(20.0);
                if self.last_sent_mode != Some(WorkoutStepMode::Resistance)
                    || self.last_sent_resistance != Some(r)
                {
                    if let Err(err) = self.transport.set_resistance_pct(r).await {
                        tracing::warn!(error = %err, "Failed to send resistance pct to trainer");
                    } else {
                        self.last_sent_mode = Some(WorkoutStepMode::Resistance);
                        self.last_sent_resistance = Some(r);
                        self.last_sent_watts = None;
                        self.last_sent_grade = None;
                    }
                }
            }
        }
    }

    pub async fn handle_command(&mut self, cmd: BridgeCommand) -> Vec<BridgeEvent> {
        let mut events = Vec::new();
        match cmd {
            BridgeCommand::ScanSensors => {
                if let Err(err) = self.transport.scan_sensors().await {
                    events.push(BridgeEvent::Error {
                        code: "SCAN_FAILED".to_string(),
                        message: err.to_string(),
                    });
                }
            }
            BridgeCommand::LoadWorkout {
                workout_id,
                planned_session_id,
                name,
                ftp_watts,
                lthr_bpm,
                hrmax_bpm,
                weight_kg,
                steps,
            } => {
                if matches!(
                    self.state,
                    WorkoutExecutionState::Running
                        | WorkoutExecutionState::Paused
                        | WorkoutExecutionState::AutoPaused
                ) {
                    events.push(BridgeEvent::Error {
                        code: "WORKOUT_ACTIVE".to_string(),
                        message: "Stop or discard the current ride before loading a new workout"
                            .to_string(),
                    });
                    return events;
                }
                self.reset_session();
                self.meta = ActiveWorkoutMeta {
                    workout_id,
                    planned_session_id,
                    name,
                    ftp_watts,
                    lthr_bpm,
                    hrmax_bpm,
                    weight_kg,
                };
                self.steps = steps;
                self.state = WorkoutExecutionState::Armed;
            }
            BridgeCommand::Start => {
                if matches!(
                    self.state,
                    WorkoutExecutionState::Idle
                        | WorkoutExecutionState::Armed
                        | WorkoutExecutionState::Completed
                ) {
                    if self.steps.is_empty() {
                        self.steps = vec![FlattenedStep {
                            step_index: 0,
                            label: "Free Ride".to_string(),
                            start_offset_s: 0,
                            duration_s: 3600,
                            mode: WorkoutStepMode::Erg,
                            watts_start: Some(150),
                            watts_end: Some(150),
                            grade_pct: None,
                            resistance_pct: None,
                            cadence_rpm: None,
                            text_cue: None,
                            is_work_interval: false,
                        }];
                    }
                    self.reset_session();
                    let uuid = Uuid::new_v4().to_string();
                    let now = Utc::now();
                    let started_str = now.to_rfc3339();
                    let meta_json = serde_json::to_string(&self.steps).unwrap_or_default();
                    if let Err(err) =
                        self.store
                            .begin_ride(&uuid, &self.meta.name, &started_str, &meta_json)
                    {
                        events.push(BridgeEvent::Error {
                            code: "STORAGE_ERROR".to_string(),
                            message: err.to_string(),
                        });
                        return events;
                    }
                    self.ride_uuid = Some(uuid);
                    self.started_at = Some(now);
                    self.state = WorkoutExecutionState::Running;
                }
            }
            BridgeCommand::Pause => {
                if matches!(
                    self.state,
                    WorkoutExecutionState::Running | WorkoutExecutionState::AutoPaused
                ) {
                    self.state = WorkoutExecutionState::Paused;
                    let recovery = ((u32::from(self.meta.ftp_watts) * 45) / 100) as u16;
                    self.apply_trainer_command(
                        WorkoutStepMode::Erg,
                        Some(recovery.min(110)),
                        None,
                        None,
                    )
                    .await;
                }
            }
            BridgeCommand::Resume => {
                if matches!(
                    self.state,
                    WorkoutExecutionState::Paused | WorkoutExecutionState::AutoPaused
                ) {
                    self.erg_guard.reset();
                    self.state = WorkoutExecutionState::Running;
                }
            }
            BridgeCommand::SkipStep => {
                if self.step_index + 1 < self.steps.len() {
                    self.step_index += 1;
                    self.step_elapsed_s = 0;
                    self.manual_mode_override = None;
                }
            }
            BridgeCommand::PrevStep => {
                if self.step_elapsed_s <= 5 && self.step_index > 0 {
                    self.step_index -= 1;
                }
                self.step_elapsed_s = 0;
                self.manual_mode_override = None;
            }
            BridgeCommand::ExtendStep { seconds } => {
                if let Some(step) = self.steps.get_mut(self.step_index) {
                    let updated = i64::from(step.duration_s) + i64::from(seconds);
                    step.duration_s = updated.max(i64::from(self.step_elapsed_s) + 5) as u32;
                }
            }
            BridgeCommand::SetErgBias { bias_pct } => {
                self.erg_bias_pct = bias_pct.clamp(50, 150);
            }
            BridgeCommand::SetManualTarget {
                mode,
                watts,
                grade_pct,
                resistance_pct,
            } => {
                self.manual_mode_override = Some(mode);
                self.manual_watts_override = watts;
                self.manual_grade_override = grade_pct;
                self.manual_resistance_override = resistance_pct;
            }
            BridgeCommand::StopAndSave { rpe, feel, notes } => {
                if let (Some(uuid), Some(started)) = (self.ride_uuid.clone(), self.started_at) {
                    let metrics = compute_ride_metrics(
                        &self.samples,
                        self.meta.ftp_watts,
                        self.meta.lthr_bpm,
                        self.meta.hrmax_bpm,
                        self.meta.weight_kg,
                        Some(&self.steps),
                    );
                    let fit_bytes = encode_cycling_fit(started, &self.samples, &metrics);
                    let fit_len = fit_bytes.len();
                    let summary = RideUploadSummary {
                        ride_uuid: uuid.clone(),
                        name: self.meta.name.clone(),
                        source: "indoor_bridge".to_string(),
                        workout_id: self.meta.workout_id.clone(),
                        planned_session_id: self.meta.planned_session_id.clone(),
                        started_at: started.to_rfc3339(),
                        ride_day: started.format("%Y-%m-%d").to_string(),
                        duration_s: metrics.duration_s,
                        elapsed_s: metrics.elapsed_s,
                        work_kj: metrics.work_kj,
                        avg_power: metrics.avg_power,
                        np_watts: metrics.np_watts,
                        intensity_factor: metrics.intensity_factor,
                        tss: metrics.tss,
                        variability_index: metrics.variability_index,
                        avg_hr: metrics.avg_hr,
                        max_hr: metrics.max_hr,
                        efficiency_factor: metrics.efficiency_factor,
                        pw_hr_decoupling: metrics.pw_hr_decoupling,
                        hrr_60s: metrics.hrr_60s,
                        time_gt_90_hrmax_s: metrics.time_gt_90_hrmax_s,
                        avg_cadence: metrics.avg_cadence,
                        compliance_pct: metrics.compliance_pct,
                        power_zones: metrics.power_zones,
                        hr_zones: metrics.hr_zones,
                        quality_flags: metrics.quality_flags,
                        ftp_snapshot: self.meta.ftp_watts,
                        lthr_snapshot: self.meta.lthr_bpm,
                        hrmax_snapshot: self.meta.hrmax_bpm,
                        weight_kg_snapshot: self.meta.weight_kg,
                        rpe,
                        feel,
                        notes: notes.unwrap_or_default(),
                        intervals: metrics.intervals,
                        peaks: metrics.peaks,
                    };

                    match serde_json::to_string(&summary) {
                        Ok(summary_json) => {
                            let now_unix = Utc::now().timestamp();
                            if let Err(err) = self.store.finish_and_queue_upload(
                                &uuid,
                                &summary_json,
                                &fit_bytes,
                                now_unix,
                            ) {
                                events.push(BridgeEvent::Error {
                                    code: "SAVE_FAILED".to_string(),
                                    message: err.to_string(),
                                });
                            } else {
                                self.upload_notify.notify_one();
                                events.push(BridgeEvent::RideSaved {
                                    ride_uuid: uuid,
                                    upload_status: UploadStatus::Queued,
                                    fit_bytes: fit_len,
                                });
                            }
                        }
                        Err(err) => {
                            events.push(BridgeEvent::Error {
                                code: "SERIALIZE_FAILED".to_string(),
                                message: err.to_string(),
                            });
                        }
                    }
                }
                self.reset_session();
                self.steps.clear();
                self.state = WorkoutExecutionState::Idle;
            }
            BridgeCommand::Discard => {
                if let Some(uuid) = &self.ride_uuid {
                    let _ = self.store.discard_ride(uuid);
                }
                self.reset_session();
                self.steps.clear();
                self.state = WorkoutExecutionState::Idle;
            }
            BridgeCommand::InjectMockFault {
                cadence_zero_seconds,
            } => {
                if let Err(err) = self
                    .transport
                    .inject_fault_cadence_zero(cadence_zero_seconds)
                    .await
                {
                    events.push(BridgeEvent::Error {
                        code: "FAULT_INJECT_FAILED".to_string(),
                        message: err.to_string(),
                    });
                }
            }
        }
        events
    }

    pub async fn tick_one_second(&mut self) -> BridgeEvent {
        self.transport.advance_simulated_second().await;
        let (raw, sensors) = self.transport.read_sample().await;
        let mut route_position: Option<SyntheticRoutePosition> = None;

        if let Some(w) = raw.watts {
            if self.watts_window_3s.len() == 3 {
                self.watts_window_3s.pop_front();
            }
            self.watts_window_3s.push_back(w);
        }
        let watts_3s = if self.watts_window_3s.is_empty() {
            None
        } else {
            let sum: u32 = self.watts_window_3s.iter().map(|w| u32::from(*w)).sum();
            Some((sum as f64 / self.watts_window_3s.len() as f64).round() as u16)
        };

        let (mut mode, mut target_watts, target_grade, target_res) = self.compute_desired_target();

        if matches!(
            self.state,
            WorkoutExecutionState::Running | WorkoutExecutionState::AutoPaused
        ) {
            if mode == WorkoutStepMode::Erg {
                let desired = target_watts.unwrap_or(120);
                match self
                    .erg_guard
                    .update(mode, self.elapsed_s, desired, raw.cadence_rpm)
                {
                    ErgGuardOutcome::Normal { effective_watts } => {
                        target_watts = Some(effective_watts);
                        self.state = WorkoutExecutionState::Running;
                    }
                    ErgGuardOutcome::EnterAutoPause { recovery_watts }
                    | ErgGuardOutcome::StayAutoPaused { recovery_watts } => {
                        target_watts = Some(recovery_watts);
                        self.state = WorkoutExecutionState::AutoPaused;
                    }
                    ErgGuardOutcome::ResumedWithRamp { effective_watts } => {
                        target_watts = Some(effective_watts);
                        self.state = WorkoutExecutionState::Running;
                    }
                }
            } else {
                self.erg_guard
                    .update(mode, self.elapsed_s, 0, raw.cadence_rpm);
                self.state = WorkoutExecutionState::Running;
            }

            self.apply_trainer_command(mode, target_watts, target_grade, target_res)
                .await;

            if self.state == WorkoutExecutionState::Running {
                let sample = if self.synthetic_route_enabled {
                    let position = self.synthetic_route.advance_one_second(raw.watts);
                    self.last_route_position = Some(position);
                    route_position = Some(position);
                    TelemetrySample {
                        t_s: self.elapsed_s,
                        watts: raw.watts,
                        hr_bpm: raw.hr_bpm,
                        cadence_rpm: raw.cadence_rpm,
                        speed_kph: Some(position.speed_kph),
                        target_watts,
                        step_index: Some(self.step_index),
                        erg_bias_pct: Some(self.erg_bias_pct),
                        synthetic_route: true,
                        lat_deg: Some(position.lat_deg),
                        lon_deg: Some(position.lon_deg),
                        elevation_m: Some(position.elevation_m),
                        distance_m: Some(position.distance_m),
                        grade_pct: Some(position.grade_pct),
                    }
                } else {
                    TelemetrySample {
                        t_s: self.elapsed_s,
                        watts: raw.watts,
                        hr_bpm: raw.hr_bpm,
                        cadence_rpm: raw.cadence_rpm,
                        speed_kph: raw.speed_kph,
                        target_watts,
                        step_index: Some(self.step_index),
                        erg_bias_pct: Some(self.erg_bias_pct),
                        synthetic_route: false,
                        lat_deg: None,
                        lon_deg: None,
                        elevation_m: None,
                        distance_m: None,
                        grade_pct: None,
                    }
                };
                if let Some(uuid) = &self.ride_uuid
                    && let Err(err) = self.store.append_sample(uuid, &sample)
                {
                    tracing::warn!(error = %err, "Failed to persist 1Hz sample to SQLite");
                }
                self.samples.push(sample);
                self.elapsed_s += 1;
                self.step_elapsed_s += 1;

                if let Some(cur) = self.steps.get(self.step_index)
                    && self.step_elapsed_s >= cur.duration_s
                {
                    if self.step_index + 1 < self.steps.len() {
                        self.step_index += 1;
                        self.step_elapsed_s = 0;
                        self.manual_mode_override = None;
                    } else {
                        self.state = WorkoutExecutionState::Completed;
                        let cooldown_w = ((u32::from(self.meta.ftp_watts) * 45) / 100) as u16;
                        mode = WorkoutStepMode::Erg;
                        target_watts = Some(cooldown_w.min(120));
                        self.apply_trainer_command(mode, target_watts, None, None)
                            .await;
                    }
                }
            }
        }

        let cur_step = self.steps.get(self.step_index);
        let step_remaining =
            cur_step.map_or(0, |s| s.duration_s.saturating_sub(self.step_elapsed_s));
        let pending_uploads = self.store.pending_upload_count().unwrap_or(0);

        let telemetry_route = if self.synthetic_route_enabled {
            route_position.or(self.last_route_position)
        } else {
            None
        };

        BridgeEvent::Telemetry {
            ts_ms: Utc::now().timestamp_millis(),
            ride_uuid: self.ride_uuid.clone(),
            workout_name: if self.state == WorkoutExecutionState::Idle {
                None
            } else {
                Some(self.meta.name.clone())
            },
            state: self.state,
            elapsed_s: self.elapsed_s,
            step_index: self.step_index,
            total_steps: self.steps.len(),
            step_label: cur_step.map(|s| s.label.clone()),
            step_elapsed_s: self.step_elapsed_s,
            step_remaining_s: step_remaining,
            mode,
            target_watts,
            target_grade_pct: target_grade,
            erg_bias_pct: self.erg_bias_pct,
            watts: raw.watts,
            watts_3s,
            cadence_rpm: raw.cadence_rpm,
            hr_bpm: raw.hr_bpm,
            speed_kph: telemetry_route.map_or(raw.speed_kph, |position| Some(position.speed_kph)),
            synthetic_route: telemetry_route.is_some(),
            lat_deg: telemetry_route.map(|position| position.lat_deg),
            lon_deg: telemetry_route.map(|position| position.lon_deg),
            elevation_m: telemetry_route.map(|position| position.elevation_m),
            distance_m: telemetry_route.map(|position| position.distance_m),
            grade_pct: telemetry_route.map(|position| position.grade_pct),
            text_cue: cur_step.and_then(|s| s.text_cue.clone()),
            sensors,
            pending_uploads,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::mock::MockTransport;

    fn sample_steps() -> Vec<FlattenedStep> {
        vec![
            FlattenedStep {
                step_index: 0,
                label: "Warmup".to_string(),
                start_offset_s: 0,
                duration_s: 20,
                mode: WorkoutStepMode::Erg,
                watts_start: Some(150),
                watts_end: Some(250),
                grade_pct: None,
                resistance_pct: None,
                cadence_rpm: Some(90),
                text_cue: Some("Warm up".to_string()),
                is_work_interval: false,
            },
            FlattenedStep {
                step_index: 1,
                label: "Threshold".to_string(),
                start_offset_s: 20,
                duration_s: 15,
                mode: WorkoutStepMode::Erg,
                watts_start: Some(260),
                watts_end: Some(260),
                grade_pct: None,
                resistance_pct: None,
                cadence_rpm: Some(90),
                text_cue: None,
                is_work_interval: true,
            },
        ]
    }

    #[tokio::test]
    async fn workout_engine_executes_erg_guard_and_saves_fit_to_upload_queue() -> anyhow::Result<()>
    {
        let transport = Arc::new(MockTransport::new());
        let store = SqliteStore::open_in_memory()?;
        let notify = Arc::new(Notify::new());
        let mut engine = WorkoutEngine::new(transport, store.clone(), notify);

        let load_events = engine
            .handle_command(BridgeCommand::LoadWorkout {
                workout_id: Some("w-1".to_string()),
                planned_session_id: None,
                name: "Test Ride".to_string(),
                ftp_watts: 260,
                lthr_bpm: Some(172),
                hrmax_bpm: Some(190),
                weight_kg: Some(72.0),
                steps: sample_steps(),
            })
            .await;
        assert!(load_events.is_empty());
        assert_eq!(engine.state(), WorkoutExecutionState::Armed);

        engine.handle_command(BridgeCommand::Start).await;
        assert_eq!(engine.state(), WorkoutExecutionState::Running);

        // Run 5 normal seconds (default mode keeps synthetic route disabled)
        for _ in 0..5 {
            let event = engine.tick_one_second().await;
            if let BridgeEvent::Telemetry {
                synthetic_route,
                lat_deg,
                lon_deg,
                elevation_m,
                distance_m,
                grade_pct,
                ..
            } = event
            {
                assert!(!synthetic_route);
                assert!(lat_deg.is_none());
                assert!(lon_deg.is_none());
                assert!(elevation_m.is_none());
                assert!(distance_m.is_none());
                assert!(grade_pct.is_none());
            } else {
                anyhow::bail!("expected telemetry event");
            }
        }
        assert_eq!(engine.elapsed_s(), 5);

        // Inject 4 seconds of zero cadence -> triggers AutoPaused, then recovers
        engine
            .handle_command(BridgeCommand::InjectMockFault {
                cadence_zero_seconds: 4,
            })
            .await;

        let mut saw_auto_pause = false;
        for _ in 0..10 {
            let ev = engine.tick_one_second().await;
            if let BridgeEvent::Telemetry { state, .. } = ev
                && state == WorkoutExecutionState::AutoPaused
            {
                saw_auto_pause = true;
            }
        }
        assert!(saw_auto_pause);
        assert_eq!(engine.state(), WorkoutExecutionState::Running);

        // Run remaining ticks to completion
        for _ in 0..30 {
            engine.tick_one_second().await;
        }
        assert_eq!(engine.state(), WorkoutExecutionState::Completed);

        let save_events = engine
            .handle_command(BridgeCommand::StopAndSave {
                rpe: Some(7),
                feel: Some(4),
                notes: Some("Clean recovery".to_string()),
            })
            .await;
        assert_eq!(save_events.len(), 1);
        assert!(matches!(save_events[0], BridgeEvent::RideSaved { .. }));
        assert_eq!(store.pending_upload_count()?, 1);
        Ok(())
    }

    #[tokio::test]
    async fn opt_in_synthetic_route_uses_measured_power_and_persists_across_pause()
    -> anyhow::Result<()> {
        let transport = Arc::new(MockTransport::new());
        let store = SqliteStore::open_in_memory()?;
        let notify = Arc::new(Notify::new());
        let mut engine = WorkoutEngine::new(transport, store, notify).with_synthetic_route(true);

        engine
            .handle_command(BridgeCommand::LoadWorkout {
                workout_id: Some("w-route".to_string()),
                planned_session_id: None,
                name: "Virtual Route Ride".to_string(),
                ftp_watts: 260,
                lthr_bpm: Some(172),
                hrmax_bpm: Some(190),
                weight_kg: Some(72.0),
                steps: sample_steps(),
            })
            .await;
        engine.handle_command(BridgeCommand::Start).await;

        let mut last_distance = 0.0;
        for _ in 0..3 {
            let event = engine.tick_one_second().await;
            if let BridgeEvent::Telemetry {
                synthetic_route,
                lat_deg,
                lon_deg,
                elevation_m,
                distance_m,
                grade_pct,
                ..
            } = event
            {
                assert!(synthetic_route);
                assert!(lat_deg.is_some());
                assert!(lon_deg.is_some());
                assert!(elevation_m.is_some());
                let dist = distance_m.ok_or_else(|| anyhow::anyhow!("missing distance"))?;
                assert!(dist > last_distance);
                last_distance = dist;
                assert!(grade_pct.is_some());
            } else {
                anyhow::bail!("expected synthetic route telemetry");
            }
        }

        // Pausing keeps the last known route position instead of blanking out telemetry
        engine.handle_command(BridgeCommand::Pause).await;
        let paused_ev = engine.tick_one_second().await;
        if let BridgeEvent::Telemetry {
            synthetic_route,
            distance_m,
            ..
        } = paused_ev
        {
            assert!(synthetic_route);
            assert_eq!(distance_m, Some(last_distance));
        } else {
            anyhow::bail!("expected paused telemetry event");
        }
        Ok(())
    }
}
