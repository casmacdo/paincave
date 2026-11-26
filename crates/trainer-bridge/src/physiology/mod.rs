use std::collections::HashMap;

use crate::protocol::{
    FlattenedStep, HrZoneSeconds, IntervalExecution, IntervalStatus, MmpPoint, PowerZoneSeconds,
    QualityFlags, TelemetrySample,
};

pub const MMP_DURATIONS: [u32; 11] = [5, 15, 30, 60, 120, 300, 480, 720, 1200, 1800, 3600];

#[derive(Debug, Clone, PartialEq)]
pub struct RideMetricsResult {
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
    pub intervals: Vec<IntervalExecution>,
    pub peaks: Vec<MmpPoint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CriticalPowerEstimate {
    pub cp_watts: u16,
    pub w_prime_j: u32,
    pub r_squared: f64,
    pub eftp_watts: u16,
}

/// Matches JS `Math.round(x)` (rounds half toward +infinity).
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

fn round_dp(x: f64, decimals: i32) -> f64 {
    let factor = 10_f64.powi(decimals);
    js_round(x * factor) / factor
}

pub fn compute_normalized_power(power_series: &[f64]) -> f64 {
    let n = power_series.len();
    if n == 0 {
        return 0.0;
    }
    if n < 30 {
        let sum: f64 = power_series.iter().map(|w| w.max(0.0)).sum();
        return sum / (n as f64);
    }

    let mut rolling_sum: f64 = power_series[..30].iter().map(|w| w.max(0.0)).sum();
    let mut sum_fourth = (rolling_sum / 30.0).powi(4);
    let mut count = 1usize;

    for i in 30..n {
        rolling_sum += power_series[i].max(0.0) - power_series[i - 30].max(0.0);
        let avg = rolling_sum / 30.0;
        sum_fourth += avg.powi(4);
        count += 1;
    }

    (sum_fourth / (count as f64)).powf(0.25)
}

pub fn compute_power_zones(power_series: &[f64], ftp_watts: u16) -> PowerZoneSeconds {
    let mut zones = PowerZoneSeconds::default();
    if ftp_watts == 0 {
        return zones;
    }
    let ftp = f64::from(ftp_watts);
    for &w in power_series {
        let pct = (w.max(0.0) / ftp) * 100.0;
        if pct < 55.0 {
            zones.z1 += 1;
        } else if pct <= 75.0 {
            zones.z2 += 1;
        } else if pct <= 90.0 {
            zones.z3 += 1;
        } else if pct <= 105.0 {
            zones.z4 += 1;
        } else if pct <= 120.0 {
            zones.z5 += 1;
        } else if pct <= 150.0 {
            zones.z6 += 1;
        } else {
            zones.z7 += 1;
        }
    }
    zones
}

pub fn compute_mmp_curve(power_series: &[f64], weight_kg: Option<f64>) -> Vec<MmpPoint> {
    let n = power_series.len();
    if n == 0 {
        return Vec::new();
    }

    let mut prefix = Vec::with_capacity(n + 1);
    prefix.push(0.0_f64);
    let mut acc = 0.0_f64;
    for &w in power_series {
        if w > 0.0 {
            acc += w;
        }
        prefix.push(acc);
    }

    let valid_weight = weight_kg.filter(|w| *w > 0.0);
    let mut peaks = Vec::new();

    for duration in MMP_DURATIONS {
        let d_usize = duration as usize;
        if d_usize > n {
            continue;
        }
        let mut max_sum = 0.0_f64;
        for i in 0..=(n - d_usize) {
            let sum = prefix[i + d_usize] - prefix[i];
            if sum > max_sum {
                max_sum = sum;
            }
        }
        let watts = js_round(max_sum / f64::from(duration)).max(0.0) as u16;
        peaks.push(MmpPoint {
            duration_s: duration,
            watts,
            w_per_kg: valid_weight.map(|w| round_dp(f64::from(watts) / w, 2)),
        });
    }

    peaks
}

pub fn estimate_critical_power(peaks: &[MmpPoint]) -> Option<CriticalPowerEstimate> {
    let pts: Vec<(f64, f64)> = peaks
        .iter()
        .filter(|p| p.duration_s >= 120 && p.duration_s <= 1200 && p.watts > 0)
        .map(|p| {
            (
                f64::from(p.duration_s),
                f64::from(p.watts) * f64::from(p.duration_s),
            )
        })
        .collect();

    if pts.len() < 3 {
        return None;
    }

    let n = pts.len() as f64;
    let sum_x: f64 = pts.iter().map(|(x, _)| *x).sum();
    let sum_y: f64 = pts.iter().map(|(_, y)| *y).sum();
    let mean_x = sum_x / n;
    let mean_y = sum_y / n;

    let mut ss_xx = 0.0;
    let mut ss_xy = 0.0;
    let mut ss_yy = 0.0;
    for (x, y) in pts {
        let dx = x - mean_x;
        let dy = y - mean_y;
        ss_xx += dx * dx;
        ss_xy += dx * dy;
        ss_yy += dy * dy;
    }
    if ss_xx <= 0.0 || ss_yy <= 0.0 {
        return None;
    }

    let cp = ss_xy / ss_xx;
    let w_prime = mean_y - cp * mean_x;
    let r_squared = (ss_xy * ss_xy) / (ss_xx * ss_yy);
    if cp <= 50.0 || w_prime < 2000.0 || r_squared < 0.95 {
        return None;
    }

    let mmp20 = peaks.iter().find(|p| p.duration_s == 1200);
    let eftp = mmp20
        .map(|p| js_round(f64::from(p.watts) * 0.95) as u16)
        .unwrap_or_else(|| js_round(cp) as u16);

    Some(CriticalPowerEstimate {
        cp_watts: js_round(cp) as u16,
        w_prime_j: js_round(w_prime) as u32,
        r_squared: round_dp(r_squared, 4),
        eftp_watts: eftp,
    })
}

fn compute_pw_hr_decoupling(samples: &[TelemetrySample]) -> Option<f64> {
    let n = samples.len();
    if n < 1200 {
        return None;
    }

    let valid_hr = samples
        .iter()
        .filter(|s| s.hr_bpm.is_some_and(|hr| hr > 0))
        .count();
    if (valid_hr as f64) / (n as f64) < 0.85 {
        return None;
    }

    let warmup_skip = if n >= 2400 { 600 } else { 0 };
    let half = (n - warmup_skip) / 2;
    if half < 30 {
        return None;
    }

    let mut h1_power = Vec::with_capacity(half);
    let mut h2_power = Vec::with_capacity(half);
    let mut h1_hr_sum = 0.0_f64;
    let mut h1_hr_cnt = 0usize;
    let mut h2_hr_sum = 0.0_f64;
    let mut h2_hr_cnt = 0usize;

    for i in 0..half {
        let s1 = &samples[warmup_skip + i];
        let s2 = &samples[warmup_skip + half + i];
        h1_power.push(f64::from(s1.watts.unwrap_or(0)));
        h2_power.push(f64::from(s2.watts.unwrap_or(0)));
        if let Some(hr) = s1.hr_bpm.filter(|h| *h > 0) {
            h1_hr_sum += f64::from(hr);
            h1_hr_cnt += 1;
        }
        if let Some(hr) = s2.hr_bpm.filter(|h| *h > 0) {
            h2_hr_sum += f64::from(hr);
            h2_hr_cnt += 1;
        }
    }

    if h1_hr_cnt == 0 || h2_hr_cnt == 0 {
        return None;
    }

    let np1 = compute_normalized_power(&h1_power);
    let np2 = compute_normalized_power(&h2_power);
    let ef1 = np1 / (h1_hr_sum / (h1_hr_cnt as f64));
    let ef2 = np2 / (h2_hr_sum / (h2_hr_cnt as f64));
    if ef1 <= 0.0 {
        return None;
    }

    Some(round_dp(((ef1 - ef2) / ef1) * 100.0, 2))
}

fn compute_hrr_60s(
    samples: &[TelemetrySample],
    power_series: &[f64],
    ftp_watts: u16,
) -> Option<i32> {
    let n = samples.len();
    if n < 75 || ftp_watts == 0 {
        return None;
    }

    let recovery_threshold = 0.65 * f64::from(ftp_watts);
    let mut p_prefix = vec![0.0_f64; n + 1];
    let mut hr_prefix = vec![0.0_f64; n + 1];
    let mut hr_valid_prefix = vec![0i32; n + 1];

    for i in 0..n {
        p_prefix[i + 1] = p_prefix[i] + power_series[i];
        let valid_hr = samples[i].hr_bpm.filter(|h| *h > 0);
        hr_prefix[i + 1] = hr_prefix[i] + valid_hr.map_or(0.0, f64::from);
        hr_valid_prefix[i + 1] = hr_valid_prefix[i] + i32::from(valid_hr.is_some());
    }

    let mut best_peak_avg = -1.0_f64;
    let mut best_peak_idx: Option<usize> = None;

    for t in 14..=(n - 61) {
        if samples[t + 60].hr_bpm.is_none_or(|h| h == 0) {
            continue;
        }
        if hr_valid_prefix[t + 1] - hr_valid_prefix[t - 14] < 15 {
            continue;
        }
        let rec_power_sum = p_prefix[t + 61] - p_prefix[t + 1];
        if rec_power_sum / 60.0 >= recovery_threshold {
            continue;
        }
        let avg15 = (hr_prefix[t + 1] - hr_prefix[t - 14]) / 15.0;
        if avg15 > best_peak_avg {
            best_peak_avg = avg15;
            best_peak_idx = Some(t);
        }
    }

    let peak_idx = best_peak_idx?;
    let hr_later = samples[peak_idx + 60].hr_bpm?;
    Some(js_round(best_peak_avg - f64::from(hr_later)) as i32)
}

fn detect_erg_smoothing(
    samples: &[TelemetrySample],
    planned_steps: Option<&[FlattenedStep]>,
) -> bool {
    let mut step_map = HashMap::new();
    if let Some(steps) = planned_steps {
        for s in steps {
            step_map.insert(s.step_index, s);
        }
    }

    let mut run_count = 0usize;
    let mut run_sum = 0.0_f64;
    let mut run_sum_sq = 0.0_f64;
    let mut prev_target: Option<u16> = None;
    let mut prev_step_idx: Option<usize> = None;

    let is_smoothed = |cnt: usize, sum: f64, sum_sq: f64| -> bool {
        if cnt < 60 {
            return false;
        }
        let mean = sum / (cnt as f64);
        let variance = (sum_sq / (cnt as f64) - mean * mean).max(0.0);
        variance.sqrt() < 1.5
    };

    for s in samples {
        let is_steady_erg = match s.step_index.and_then(|idx| step_map.get(&idx)) {
            Some(step) => {
                step.mode == crate::protocol::WorkoutStepMode::Erg
                    && step.watts_start == step.watts_end
            }
            None => s.target_watts.is_some(),
        };

        let valid_target =
            is_steady_erg && s.target_watts.is_some_and(|t| t >= 100) && s.watts.is_some();

        if valid_target && s.target_watts == prev_target && s.step_index == prev_step_idx {
            let diff = f64::from(s.watts.unwrap_or(0)) - f64::from(s.target_watts.unwrap_or(0));
            run_count += 1;
            run_sum += diff;
            run_sum_sq += diff * diff;
        } else {
            if is_smoothed(run_count, run_sum, run_sum_sq) {
                return true;
            }
            if valid_target {
                let diff = f64::from(s.watts.unwrap_or(0)) - f64::from(s.target_watts.unwrap_or(0));
                run_count = 1;
                run_sum = diff;
                run_sum_sq = diff * diff;
                prev_target = s.target_watts;
                prev_step_idx = s.step_index;
            } else {
                run_count = 0;
                run_sum = 0.0;
                run_sum_sq = 0.0;
                prev_target = None;
                prev_step_idx = None;
            }
        }
    }

    is_smoothed(run_count, run_sum, run_sum_sq)
}

pub fn compute_interval_executions(
    samples: &[TelemetrySample],
    planned_steps: &[FlattenedStep],
) -> Vec<IntervalExecution> {
    let mut by_step: HashMap<usize, Vec<&TelemetrySample>> = HashMap::new();
    for sample in samples {
        if let Some(step_idx) = sample.step_index {
            by_step.entry(step_idx).or_default().push(sample);
        }
    }

    planned_steps
        .iter()
        .map(|step| {
            let target_watts = match (step.mode, step.watts_start, step.watts_end) {
                (crate::protocol::WorkoutStepMode::Erg, Some(s), Some(e)) => {
                    Some(js_round((f64::from(s) + f64::from(e)) / 2.0) as u16)
                }
                _ => None,
            };

            let step_samples = by_step.get(&step.step_index);
            let actual_duration = step_samples.map_or(0, Vec::len) as u32;
            if actual_duration == 0 {
                return IntervalExecution {
                    step_index: step.step_index,
                    label: step.label.clone(),
                    mode: step.mode,
                    is_work_interval: step.is_work_interval,
                    planned_duration_s: step.duration_s,
                    actual_duration_s: 0,
                    target_watts,
                    actual_avg_watts: None,
                    pct_of_target: None,
                    avg_hr: None,
                    max_hr: None,
                    hr_drift_bpm: None,
                    avg_cadence: None,
                    erg_bias_pct: 100,
                    status: IntervalStatus::Skipped,
                };
            }

            let list = step_samples.map(Vec::as_slice).unwrap_or(&[]);
            let mut power_sum = 0u64;
            let mut power_cnt = 0u32;
            let mut hr_sum = 0u64;
            let mut hr_cnt = 0u32;
            let mut max_hr = 0u16;
            let mut cad_sum = 0u64;
            let mut cad_cnt = 0u32;
            let mut bias_sum = 0u64;
            let mut bias_cnt = 0u32;
            let mut valid_hrs = Vec::new();

            for s in list {
                if let Some(w) = s.watts {
                    power_sum += u64::from(w);
                    power_cnt += 1;
                }
                if let Some(hr) = s.hr_bpm.filter(|h| *h > 0) {
                    hr_sum += u64::from(hr);
                    hr_cnt += 1;
                    max_hr = max_hr.max(u16::from(hr));
                    valid_hrs.push(hr);
                }
                if let Some(cad) = s.cadence_rpm {
                    cad_sum += u64::from(cad);
                    cad_cnt += 1;
                }
                if let Some(bias) = s.erg_bias_pct.filter(|b| *b > 0) {
                    bias_sum += u64::from(bias);
                    bias_cnt += 1;
                }
            }

            let actual_avg_watts = if power_cnt > 0 {
                Some(js_round((power_sum as f64) / f64::from(power_cnt)) as u16)
            } else {
                None
            };
            let pct_of_target = match (actual_avg_watts, target_watts) {
                (Some(actual), Some(target)) if target > 0 => {
                    Some(round_dp((f64::from(actual) / f64::from(target)) * 100.0, 1))
                }
                _ => None,
            };

            let hr_drift_bpm = if actual_duration >= 60 && valid_hrs.len() >= 30 {
                let third = (valid_hrs.len() / 3).max(1);
                let first_sum: f64 = valid_hrs[..third].iter().map(|h| f64::from(*h)).sum();
                let last_sum: f64 = valid_hrs[valid_hrs.len() - third..]
                    .iter()
                    .map(|h| f64::from(*h))
                    .sum();
                Some(js_round(last_sum / (third as f64) - first_sum / (third as f64)) as i32)
            } else {
                None
            };

            let min_complete = (f64::from(step.duration_s) * 0.9).floor() as u32;
            let status = if actual_duration >= min_complete {
                IntervalStatus::Completed
            } else {
                IntervalStatus::Partial
            };

            IntervalExecution {
                step_index: step.step_index,
                label: step.label.clone(),
                mode: step.mode,
                is_work_interval: step.is_work_interval,
                planned_duration_s: step.duration_s,
                actual_duration_s: actual_duration,
                target_watts,
                actual_avg_watts,
                pct_of_target,
                avg_hr: if hr_cnt > 0 {
                    Some(js_round((hr_sum as f64) / f64::from(hr_cnt)) as u16)
                } else {
                    None
                },
                max_hr: if hr_cnt > 0 { Some(max_hr) } else { None },
                hr_drift_bpm,
                avg_cadence: if cad_cnt > 0 {
                    Some(js_round((cad_sum as f64) / f64::from(cad_cnt)) as u16)
                } else {
                    None
                },
                erg_bias_pct: if bias_cnt > 0 {
                    js_round((bias_sum as f64) / f64::from(bias_cnt)) as u16
                } else {
                    100
                },
                status,
            }
        })
        .collect()
}

fn compute_compliance_pct(intervals: &[IntervalExecution]) -> Option<f64> {
    let work_erg: Vec<&IntervalExecution> = intervals
        .iter()
        .filter(|iv| iv.is_work_interval && iv.target_watts.is_some_and(|t| t > 0))
        .collect();
    let candidates: Vec<&IntervalExecution> = if !work_erg.is_empty() {
        work_erg
    } else {
        intervals
            .iter()
            .filter(|iv| iv.target_watts.is_some_and(|t| t > 0))
            .collect()
    };

    if candidates.is_empty() {
        return None;
    }

    let mut weighted_score = 0.0_f64;
    let mut total_planned = 0.0_f64;
    for iv in candidates {
        if iv.planned_duration_s == 0 {
            continue;
        }
        let planned = f64::from(iv.planned_duration_s);
        total_planned += planned;
        if iv.status == IntervalStatus::Skipped {
            continue;
        }
        if let Some(pct) = iv.pct_of_target {
            let accuracy = (1.0 - (100.0 - pct).abs() / 100.0).max(0.0);
            let completion = (f64::from(iv.actual_duration_s) / planned).min(1.0);
            weighted_score += accuracy * completion * 100.0 * planned;
        }
    }

    if total_planned <= 0.0 {
        None
    } else {
        Some(round_dp(weighted_score / total_planned, 1))
    }
}

pub fn compute_ride_metrics(
    samples: &[TelemetrySample],
    ftp_watts: u16,
    lthr_bpm: Option<u16>,
    hrmax_bpm: Option<u16>,
    weight_kg: Option<f64>,
    planned_steps: Option<&[FlattenedStep]>,
) -> RideMetricsResult {
    let n = samples.len();
    let mut power_series = Vec::with_capacity(n);
    let mut total_watts = 0.0_f64;
    let mut valid_power_count = 0usize;
    let mut power_dropouts = 0u32;
    let mut hr_sum = 0.0_f64;
    let mut hr_count = 0usize;
    let mut max_hr = 0u16;
    let mut hr_dropouts = 0u32;
    let mut time_gt_90_hrmax = 0u32;
    let mut cad_sum = 0.0_f64;
    let mut cad_count = 0usize;
    let mut hr_zones = HrZoneSeconds::default();

    let hrmax_threshold = hrmax_bpm.map(|h| 0.9 * f64::from(h));

    for s in samples {
        match s.watts {
            Some(w) => {
                let wf = f64::from(w);
                power_series.push(wf);
                total_watts += wf;
                valid_power_count += 1;
            }
            None => {
                power_dropouts += 1;
                power_series.push(0.0);
            }
        }

        match s.hr_bpm.filter(|h| *h > 0) {
            Some(hr) => {
                let hrf = f64::from(hr);
                hr_sum += hrf;
                hr_count += 1;
                max_hr = max_hr.max(u16::from(hr));
                if hrmax_threshold.is_some_and(|thr| hrf >= thr) {
                    time_gt_90_hrmax += 1;
                }
                if let Some(lthr) = lthr_bpm.filter(|l| *l > 0) {
                    let pct = (hrf / f64::from(lthr)) * 100.0;
                    if pct < 81.0 {
                        hr_zones.z1 += 1;
                    } else if pct < 90.0 {
                        hr_zones.z2 += 1;
                    } else if pct < 94.0 {
                        hr_zones.z3 += 1;
                    } else if pct < 100.0 {
                        hr_zones.z4 += 1;
                    } else {
                        hr_zones.z5 += 1;
                    }
                }
            }
            None => {
                hr_dropouts += 1;
            }
        }

        if let Some(cad) = s.cadence_rpm {
            cad_sum += f64::from(cad);
            cad_count += 1;
        }
    }

    let first_ts = samples.first().map_or(0, |s| s.t_s);
    let last_ts = samples.last().map_or(0, |s| s.t_s);
    let elapsed_s = if n > 0 {
        (n as u32).max(last_ts.saturating_sub(first_ts) + 1)
    } else {
        0
    };

    let ftp_f = f64::from(ftp_watts);
    let work_kj = round_dp(total_watts / 1000.0, 1);
    let avg_power = if valid_power_count > 0 && n > 0 {
        Some(js_round(total_watts / (n as f64)) as u16)
    } else {
        None
    };

    let np_raw = if valid_power_count > 0 {
        Some(compute_normalized_power(&power_series))
    } else {
        None
    };
    let np_watts = np_raw.map(|np| js_round(np) as u16);
    let intensity_factor = match np_raw {
        Some(np) if ftp_watts > 0 => Some(round_dp(np / ftp_f, 3)),
        _ => None,
    };
    let tss = match np_raw {
        Some(np) if ftp_watts > 0 => round_dp(
            (((n as f64) * np * (np / ftp_f)) / (ftp_f * 3600.0)) * 100.0,
            1,
        ),
        _ => 0.0,
    };
    let variability_index = match (np_raw, avg_power) {
        (Some(np), Some(avg)) if avg > 0 => Some(round_dp(np / f64::from(avg), 2)),
        _ => None,
    };

    let avg_hr = if hr_count > 0 {
        Some(js_round(hr_sum / (hr_count as f64)) as u16)
    } else {
        None
    };
    let hr_coverage = if n > 0 {
        (hr_count as f64) / (n as f64)
    } else {
        0.0
    };
    let efficiency_factor = match (np_raw, avg_hr) {
        (Some(np), Some(hr)) if hr > 0 && hr_coverage >= 0.8 => {
            Some(round_dp(np / f64::from(hr), 2))
        }
        _ => None,
    };

    let pw_hr_decoupling = compute_pw_hr_decoupling(samples);
    let hrr_60s = compute_hrr_60s(samples, &power_series, ftp_watts);
    let power_zones = compute_power_zones(&power_series, ftp_watts);
    let intervals = match planned_steps {
        Some(steps) => compute_interval_executions(samples, steps),
        None => Vec::new(),
    };
    let compliance_pct = compute_compliance_pct(&intervals);
    let peaks = compute_mmp_curve(&power_series, weight_kg);

    RideMetricsResult {
        duration_s: n as u32,
        elapsed_s,
        work_kj,
        avg_power,
        np_watts,
        intensity_factor,
        tss,
        variability_index,
        avg_hr,
        max_hr: if hr_count > 0 { Some(max_hr) } else { None },
        efficiency_factor,
        pw_hr_decoupling,
        hrr_60s,
        time_gt_90_hrmax_s: time_gt_90_hrmax,
        avg_cadence: if cad_count > 0 {
            Some(js_round(cad_sum / (cad_count as f64)) as u16)
        } else {
            None
        },
        compliance_pct,
        power_zones,
        hr_zones,
        quality_flags: QualityFlags {
            power_dropouts_s: power_dropouts,
            hr_dropouts_s: hr_dropouts,
            erg_smoothing_detected: detect_erg_smoothing(samples, planned_steps),
        },
        intervals,
        peaks,
    }
}
