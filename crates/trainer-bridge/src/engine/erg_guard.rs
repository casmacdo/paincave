use crate::protocol::WorkoutStepMode;

/// Protects against KICKR ERG "spiral of death":
/// - 3 consecutive seconds at 0 RPM while riding in ERG mode -> AutoPaused & drop target to min(100W, 45% target)
/// - 2 consecutive seconds at >=40 RPM -> smooth 3-second linear ramp back to full target watts
#[derive(Debug, Clone, Default)]
pub struct ErgGuard {
    auto_paused: bool,
    zero_cadence_streak: u32,
    resume_cadence_streak: u32,
    ramp_step: u8, // 0 = no active ramp; 1..=3 = ramping back up
    recovery_watts_at_resume: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErgGuardOutcome {
    Normal { effective_watts: u16 },
    EnterAutoPause { recovery_watts: u16 },
    StayAutoPaused { recovery_watts: u16 },
    ResumedWithRamp { effective_watts: u16 },
}

impl ErgGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_auto_paused(&self) -> bool {
        self.auto_paused
    }

    pub fn reset(&mut self) {
        *self = Self::default();
    }

    pub fn recovery_target(desired_watts: u16) -> u16 {
        let forty_five_pct = ((u32::from(desired_watts) * 45) / 100) as u16;
        forty_five_pct.min(100).max(50.min(desired_watts))
    }

    pub fn update(
        &mut self,
        mode: WorkoutStepMode,
        elapsed_s: u32,
        desired_watts: u16,
        cadence_rpm: Option<u8>,
    ) -> ErgGuardOutcome {
        if mode != WorkoutStepMode::Erg || elapsed_s == 0 {
            self.zero_cadence_streak = 0;
            self.resume_cadence_streak = 0;
            self.ramp_step = 0;
            self.auto_paused = false;
            return ErgGuardOutcome::Normal {
                effective_watts: desired_watts,
            };
        }

        let recovery = Self::recovery_target(desired_watts);
        let cad = cadence_rpm.unwrap_or(0);

        if self.auto_paused {
            if cad >= 40 {
                self.resume_cadence_streak += 1;
                if self.resume_cadence_streak >= 2 {
                    self.auto_paused = false;
                    self.zero_cadence_streak = 0;
                    self.resume_cadence_streak = 0;
                    self.recovery_watts_at_resume = recovery;
                    self.ramp_step = 1;
                    let ramped = self.compute_ramped_watts(desired_watts);
                    return ErgGuardOutcome::ResumedWithRamp {
                        effective_watts: ramped,
                    };
                }
            } else {
                self.resume_cadence_streak = 0;
            }
            return ErgGuardOutcome::StayAutoPaused {
                recovery_watts: recovery,
            };
        }

        if cad == 0 {
            self.zero_cadence_streak += 1;
            self.ramp_step = 0;
            if self.zero_cadence_streak >= 3 {
                self.auto_paused = true;
                self.resume_cadence_streak = 0;
                return ErgGuardOutcome::EnterAutoPause {
                    recovery_watts: recovery,
                };
            }
        } else {
            self.zero_cadence_streak = 0;
        }

        if self.ramp_step > 0 {
            self.ramp_step += 1;
            if self.ramp_step > 3 {
                self.ramp_step = 0;
                return ErgGuardOutcome::Normal {
                    effective_watts: desired_watts,
                };
            }
            return ErgGuardOutcome::Normal {
                effective_watts: self.compute_ramped_watts(desired_watts),
            };
        }

        ErgGuardOutcome::Normal {
            effective_watts: desired_watts,
        }
    }

    fn compute_ramped_watts(&self, target: u16) -> u16 {
        let start = i32::from(self.recovery_watts_at_resume);
        let end = i32::from(target);
        let step = i32::from(self.ramp_step.min(3));
        (start + ((end - start) * step) / 3).max(0) as u16
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn erg_guard_triggers_after_3s_zero_and_ramps_over_3s_on_resume() {
        let mut guard = ErgGuard::new();
        // 2 seconds at 0 cadence does not auto-pause
        assert_eq!(
            guard.update(WorkoutStepMode::Erg, 10, 300, Some(0)),
            ErgGuardOutcome::Normal {
                effective_watts: 300
            }
        );
        assert_eq!(
            guard.update(WorkoutStepMode::Erg, 11, 300, Some(0)),
            ErgGuardOutcome::Normal {
                effective_watts: 300
            }
        );
        // 3rd second enters auto-pause and drops target to 100W
        assert_eq!(
            guard.update(WorkoutStepMode::Erg, 12, 300, Some(0)),
            ErgGuardOutcome::EnterAutoPause {
                recovery_watts: 100
            }
        );
        assert!(guard.is_auto_paused());

        // 1st second at 75 RPM stays auto-paused; 2nd second resumes at step 1/3 ramp
        assert_eq!(
            guard.update(WorkoutStepMode::Erg, 12, 300, Some(75)),
            ErgGuardOutcome::StayAutoPaused {
                recovery_watts: 100
            }
        );
        assert_eq!(
            guard.update(WorkoutStepMode::Erg, 12, 300, Some(80)),
            ErgGuardOutcome::ResumedWithRamp {
                effective_watts: 166
            }
        );
        assert!(!guard.is_auto_paused());

        // Step 2/3 -> 233W, Step 3/3 -> 300W
        assert_eq!(
            guard.update(WorkoutStepMode::Erg, 13, 300, Some(85)),
            ErgGuardOutcome::Normal {
                effective_watts: 233
            }
        );
        assert_eq!(
            guard.update(WorkoutStepMode::Erg, 14, 300, Some(88)),
            ErgGuardOutcome::Normal {
                effective_watts: 300
            }
        );
    }
}
