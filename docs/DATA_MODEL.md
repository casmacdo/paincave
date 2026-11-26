# PainCave Data Model, Workout Schema & Physiology Formulas

## 1. D1 SQLite Schema

The authoritative DDL lives in [apps/worker/migrations/0001_initial.sql](../apps/worker/migrations/0001_initial.sql).

### Core Tables

| Table | Purpose |
| :--- | :--- |
| `athlete_profile` | Single-row athlete identity, timezone, display units, preferred day-of-week schedule notes |
| `athlete_thresholds` | Dated history (`effective_from`) of `ftp_watts`, `lthr_bpm`, `hrmax_bpm`, `hrrest_bpm`, `cp_watts`, `w_prime_j`, `weight_kg` |
| `training_blocks` | Macro/mesocycle goals: goal event, target date, phase (`base`/`build`/`peak`/`taper`/`recovery`), weekly hours budget, day constraints JSON |
| `coaching_notes` | Durable LLM memory across sessions: category (`injury`/`preference`/`response`/`equipment`/`schedule`), note text, active flag |
| `workouts` | Canonical Zod-validated JSON workout definitions (`spec_json`) + precomputed `duration_s`, `predicted_if`, `predicted_tss`, `zone_distribution_json` |
| `planned_sessions` | Calendar entries (`scheduled_date`, `workout_id`, `status`: `planned`/`completed`/`skipped`, `coach_rationale`, linked `ride_uuid`) |
| `rides` | Completed activities (`ride_uuid` UNIQUE, `source`, `r2_fit_key`, all core physiology metrics, RPE/feel/notes, `quality_flags_json`, FTP/LTHR snapshots, Strava IDs) |
| `ride_intervals` | Per-interval compliance rows (`ride_uuid`, `step_index`, planned vs. actual watts, `%target`, avg/max HR, HR drift, cadence, ERG bias, status) |
| `ride_peaks` | MMP curve points (`ride_uuid`, `duration_s` IN `[5,15,30,60,120,300,480,720,1200,1800,3600]`, `watts`, `w_per_kg`) |
| `daily_pmc` | Daily Performance Management Chart rollup (`day` YYYY-MM-DD, `total_tss`, `ctl`, `atl`, `tsb`, `ramp_rate_7d`) |
| `oauth_tokens` | External integration tokens (Strava access/refresh/expires_at) |
| `ui_sessions` | Web UI session hashes & expiry |

### R2 Object Key Layout
- Raw `.fit` files: `fits/{YYYY}/{MM}/{ride_uuid}.fit`
- Optional cached exports: `exports/workouts/{workout_id}.zwo`

---

## 2. Canonical Workout JSON Schema (`WorkoutSpec`)

LLMs author clean JSON validated by Zod—never raw XML `.zwo` or `.erg` text.

```json
{
  "schema_version": 1,
  "name": "4x8m Threshold",
  "description": "Sustained threshold intervals with 4m Z1 recovery.",
  "category": "threshold",
  "steps": [
    {
      "type": "ramp",
      "label": "Warmup",
      "duration_s": 600,
      "start_ftp": 0.50,
      "end_ftp": 0.72,
      "cadence_rpm": 88,
      "text_cue": "Easy spin, gradually open up the legs"
    },
    {
      "type": "repeat",
      "count": 4,
      "label": "Threshold Block",
      "steps": [
        {
          "type": "steady",
          "label": "Work",
          "duration_s": 480,
          "target_ftp": 0.98,
          "cadence_rpm": 90,
          "text_cue": "Smooth torque, controlled breathing"
        },
        {
          "type": "steady",
          "label": "Recovery",
          "duration_s": 240,
          "target_ftp": 0.55,
          "text_cue": "Spin easy, drink water"
        }
      ]
    },
    {
      "type": "ramp",
      "label": "Cooldown",
      "duration_s": 300,
      "start_ftp": 0.55,
      "end_ftp": 0.40
    }
  ]
}
```

### Supported Step Types
1. `steady`: `{ type: "steady", duration_s, target_ftp | target_watts, label?, cadence_rpm?, text_cue? }`
2. `ramp`: `{ type: "ramp", duration_s, start_ftp, end_ftp, label?, cadence_rpm?, text_cue? }` (or `start_watts`/`end_watts`)
3. `slope`: `{ type: "slope", duration_s, grade_pct, label?, cadence_rpm?, text_cue? }` (SIM mode for FTP tests, sprints, or free-ride segments)
4. `free_ride`: `{ type: "free_ride", duration_s, resistance_pct?, label?, text_cue? }`
5. `repeat`: `{ type: "repeat", count: 2..50, steps: Step[], label? }` (non-nested for simplicity and clarity)

### Flattened Step Contract (Sent to `trainer-bridge`)
Before starting a ride, `packages/shared::flattenWorkout(spec, ftpWatts)` expands all `repeat` blocks and `%FTP` values into a flat array of concrete steps:
```ts
interface FlattenedStep {
  step_index: number;
  label: string;
  start_offset_s: number;
  duration_s: number;
  mode: "erg" | "slope" | "resistance";
  watts_start: number | null; // integer watts for erg
  watts_end: number | null;   // equals watts_start for steady; linearly interpolated for ramp
  grade_pct: number | null;   // for slope mode
  resistance_pct: number | null;
  cadence_rpm: number | null;
  text_cue: string | null;
  is_work_interval: boolean;  // true if target >= 0.76 * FTP or slope/free_ride test
}
```

---

## 3. Deterministic Physiology Formulas

Both `packages/shared` (TypeScript) and `crates/trainer-bridge` (Rust) implement the **exact same formulas**, verified against a shared golden test fixture (`packages/shared/fixtures/golden-ride.json`):

1. **Normalized Power (NP):**
   - Compute 30-second simple moving average $P_{30}(t)$ over 1Hz power samples (for $t \ge 29$, window $[t-29, t]$; if ride $< 30\text{s}$, fall back to arithmetic mean power).
   - $\text{NP} = \left(\frac{1}{M} \sum_{t=29}^{N-1} P_{30}(t)^4\right)^{1/4}$
2. **Intensity Factor (IF):** $\text{IF} = \text{NP} / \text{FTP}$
3. **Training Stress Score (TSS):**
   - $\text{TSS} = \frac{N_{\text{sec}} \cdot \text{NP} \cdot \text{IF}}{\text{FTP} \cdot 3600} \times 100$
4. **Variability Index (VI):** $\text{VI} = \text{NP} / P_{\text{avg}}$ (null if $P_{\text{avg}} = 0$)
5. **Work (kJ):** $\text{kJ} = \frac{1}{1000} \sum_{t=0}^{N-1} P(t)$
6. **Efficiency Factor (EF):** $\text{EF} = \text{NP} / \text{HR}_{\text{avg}}$ (null if valid HR coverage < 80%)
7. **Aerobic Decoupling (`Pw:HR` %):**
   - Computed on rides $\ge 20$ minutes with $\ge 85\%$ valid HR coverage, excluding first 10 minutes (or warmup) if ride $\ge 40$ minutes; split remaining ride into equal halves $H_1, H_2$:
   - $\text{Pw:HR} = \frac{\text{EF}_1 - \text{EF}_2}{\text{EF}_1} \times 100$ (positive = HR drifted up relative to power)
8. **HR Recovery 60s (`hrr_60s`):**
   - Find highest 15s rolling average HR peak occurring at least 60s before end of ride; record `peak_hr - hr_60s_later` (when power during recovery 60s drops below 65% FTP).
9. **Time > 90% HRmax (`time_gt_90_hrmax_s`):**
   - Count of 1Hz samples where `hr_bpm >= 0.90 * hrmax_bpm`.
10. **Coggan Power Zones (Z1–Z7):**
    - Z1: `< 55%`, Z2: `55–75%`, Z3: `76–90%`, Z4: `91–105%`, Z5: `106–120%`, Z6: `121–150%`, Z7: `> 150%` FTP.
11. **Heart Rate Zones (Z1–Z5, % of LTHR):**
    - Z1: `< 81%`, Z2: `81–89%`, Z3: `90–93%`, Z4: `94–99%`, Z5: `>= 100%` LTHR.
12. **Mean Maximal Power (MMP) — $O(N)$ Prefix Sums:**
    - Build prefix sum $S[0] = 0, S[i+1] = S[i] + P[i]$.
    - For each duration $d \in \{5, 15, 30, 60, 120, 300, 480, 720, 1200, 1800, 3600\}$ where $d \le N$:
      $$\text{MMP}(d) = \max_{i=0}^{N-d} \frac{S[i+d] - S[i]}{d}$$
13. **2-Parameter Critical Power (CP) & W':**
    - Linear regression of Total Work $W(d) = \text{MMP}(d) \cdot d = W' + \text{CP} \cdot d$ over available durations in $\{180..1200\}$s (using 3m/5m/8m/12m/20m rolling 42-day peaks when at least 3 points exist and $R^2 \ge 0.95$).
14. **PMC (CTL / ATL / TSB):**
    - For each calendar day $k$ sequentially from earliest ride to today:
      - $\text{CTL}_k = \text{CTL}_{k-1} + \frac{\text{TSS}_k - \text{CTL}_{k-1}}{42}$
      - $\text{ATL}_k = \text{ATL}_{k-1} + \frac{\text{TSS}_k - \text{ATL}_{k-1}}{7}$
      - $\text{TSB}_k = \text{CTL}_{k-1} - \text{ATL}_{k-1}$ (pre-ride freshness for day $k$)
      - $\text{RampRate}_{7d} = \text{CTL}_k - \text{CTL}_{k-7}$
