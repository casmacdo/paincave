import type {
  AnyWorkoutSpec,
  FlattenedStep,
  RideUploadSummary,
  RoutePoint,
} from "@paincave/shared";

export interface AuthProvidersInfo {
  google: boolean;
}

export interface AuthUserSummary {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface AuthState {
  authenticated: boolean;
  configured: boolean;
  auth_mode?: "better_auth" | null;
  user?: AuthUserSummary | null;
  has_owner?: boolean;
  owner_email_restricted?: boolean;
  allow_registration?: boolean;
  providers?: AuthProvidersInfo;
}

export interface AthleteProfile {
  user_id?: string;
  id?: number;
  display_name: string;
  timezone: string;
  units: "metric" | "imperial";
  primary_sports?: string[];
  features?: {
    indoor_trainer: boolean;
  };
}

export interface AthleteThreshold {
  id: string;
  effective_from: string;
  ftp_watts: number | null;
  threshold_pace_s_per_km?: number | null;
  lthr_bpm: number | null;
  hrmax_bpm: number | null;
  weight_kg: number | null;
  cp_watts: number | null;
  w_prime_j: number | null;
  notes: string | null;
}

export interface DeviceTokenRecord {
  token_hash: string;
  label: string;
  scope: "bridge" | "importer" | "mcp";
  last_used_at: string | null;
  created_at: string;
}

export interface WorkoutRecord {
  id: string;
  sport?: "cycling" | "running" | "strength" | "mobility";
  name: string;
  description: string;
  category: string;
  spec_json: string;
  duration_s: number;
  predicted_np: number | null;
  predicted_if: number | null;
  predicted_tss: number | null;
  created_by: string;
  updated_at: string;
}

export interface PlannedSessionRecord {
  id: string;
  scheduled_date: string;
  workout_id: string;
  status: "planned" | "completed" | "skipped";
  coach_rationale: string;
  completed_ride_uuid: string | null;
  workout_name: string;
  workout_sport?: "cycling" | "running" | "strength" | "mobility";
  workout_category: string;
  planned_duration_s: number;
  predicted_if: number | null;
  predicted_tss: number | null;
}

export interface RideRecord {
  ride_uuid: string;
  sport?: string;
  name: string;
  source: string;
  workout_id: string | null;
  started_at: string;
  ride_day: string;
  duration_s: number;
  distance_m?: number | null;
  avg_pace_s_per_km?: number | null;
  work_kj: number;
  avg_power: number | null;
  np_watts: number | null;
  intensity_factor: number | null;
  tss: number;
  variability_index: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  efficiency_factor: number | null;
  pw_hr_decoupling: number | null;
  hrr_60s: number | null;
  time_gt_90_hrmax_s: number;
  avg_cadence: number | null;
  compliance_pct: number | null;
  rpe: number | null;
  feel: number | null;
  notes: string;
  strava_upload_status: string;
}

export interface RouteRecord {
  id: string;
  name: string;
  source: "gpx" | "fit_extract" | "preset";
  description: string;
  distance_m: number;
  total_ascent_m: number;
  max_grade_pct: number;
  point_count: number;
  loop_route: boolean;
  is_preset: boolean;
  created_at: string | null;
}

export interface FitnessOverviewResponse {
  current_pmc: {
    day: string | null;
    ctl: number;
    atl: number;
    tsb: number;
    ramp_rate_7d: number;
  };
  daily_pmc: {
    day: string;
    total_tss: number;
    ctl: number;
    atl: number;
    tsb: number;
    ramp_rate_7d: number;
  }[];
  weekly_rollups: {
    week_start: string;
    rides: number;
    hours: number;
    tss: number;
    work_kj: number;
  }[];
  mmp_42d: { duration_s: number; watts: number; w_per_kg: number | null }[];
  mmp_90d: { duration_s: number; watts: number; w_per_kg: number | null }[];
  cp_estimate_42d: {
    cp_watts: number;
    w_prime_j: number;
    r_squared: number;
    eftp_watts: number;
  } | null;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: "same-origin",
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(errBody.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getVersion: () => requestJson<{ build_sha: string; app_env: string }>("/api/version"),
  getMe: () => requestJson<AuthState>("/api/auth/me"),
  logout: () => requestJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  getProfile: () =>
    requestJson<{ profile: AthleteProfile; latest_thresholds: AthleteThreshold | null }>(
      "/api/athlete/profile"
    ),
  updateProfile: (payload: Partial<AthleteProfile>) =>
    requestJson<{ profile: AthleteProfile }>("/api/athlete/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  getThresholds: () =>
    requestJson<{ thresholds: AthleteThreshold[] }>("/api/athlete/thresholds"),
  createThreshold: (payload: {
    effective_from: string;
    ftp_watts?: number | null;
    threshold_pace_s_per_km?: number | null;
    lthr_bpm?: number | null;
    hrmax_bpm?: number | null;
    weight_kg?: number | null;
    notes?: string | null;
  }) =>
    requestJson<{ threshold: AthleteThreshold }>("/api/athlete/thresholds", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  listDeviceTokens: () => requestJson<{ tokens: DeviceTokenRecord[] }>("/api/auth/tokens"),
  createDeviceToken: (label: string, scope: "bridge" | "importer" | "mcp") =>
    requestJson<{ token: string; token_hash: string; label: string; scope: string }>(
      "/api/auth/tokens",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, scope }),
      }
    ),
  deleteDeviceToken: (tokenHash: string) =>
    requestJson<{ ok: boolean }>(`/api/auth/tokens/${encodeURIComponent(tokenHash)}`, {
      method: "DELETE",
    }),
  getBlocks: () => requestJson<{ blocks: Record<string, unknown>[] }>("/api/athlete/blocks"),
  getNotes: () =>
    requestJson<{
      notes: {
        id: string;
        category: string;
        sport?: string | null;
        content: string;
        updated_at?: string;
      }[];
    }>("/api/athlete/notes"),
  archiveNote: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/athlete/notes/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getWorkouts: () => requestJson<{ workouts: WorkoutRecord[] }>("/api/workouts"),
  createWorkout: (spec: AnyWorkoutSpec, source?: "user" | "import") =>
    requestJson<{ workout: WorkoutRecord; warnings?: string[] }>(
      source === "import" ? "/api/workouts?source=import" : "/api/workouts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spec),
      }
    ),
  updateWorkout: (id: string, spec: AnyWorkoutSpec) =>
    requestJson<{ workout: WorkoutRecord }>(`/api/workouts/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    }),
  deleteWorkout: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/workouts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  getFlattenedWorkout: (id: string) =>
    requestJson<{
      workout_id: string;
      name: string;
      ftp_watts: number;
      lthr_bpm: number | null;
      hrmax_bpm: number | null;
      weight_kg: number | null;
      steps: FlattenedStep[];
    }>(`/api/workouts/${id}/flattened`),

  getCalendar: (start: string, end: string) =>
    requestJson<{
      planned_sessions: PlannedSessionRecord[];
      completed_rides: RideRecord[];
    }>(`/api/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`),
  scheduleSession: (payload: {
    scheduled_date: string;
    workout_id: string;
    coach_rationale?: string;
    replace_existing?: boolean;
  }) =>
    requestJson<{ session: PlannedSessionRecord; warnings: string[] }>("/api/calendar/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  updateCalendarSession: (
    id: string,
    payload: {
      scheduled_date?: string;
      status?: "planned" | "completed" | "skipped";
      coach_rationale?: string;
    }
  ) =>
    requestJson<{ session: PlannedSessionRecord }>(
      `/api/calendar/sessions/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    ),
  deleteCalendarSession: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/calendar/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  getRides: (limit = 30) => requestJson<{ rides: RideRecord[] }>(`/api/rides?limit=${limit}`),
  deleteRide: (uuid: string) =>
    requestJson<{ ok: boolean }>(`/api/rides/${encodeURIComponent(uuid)}`, { method: "DELETE" }),
  getRideDetail: (uuid: string) =>
    requestJson<{
      ride: RideRecord;
      intervals: {
        step_index: number;
        label: string;
        target_watts: number | null;
        actual_avg_watts: number | null;
        pct_of_target: number | null;
        avg_hr: number | null;
        hr_drift_bpm: number | null;
        status: string;
      }[];
      peaks: { duration_s: number; watts: number; w_per_kg: number | null }[];
    }>(`/api/rides/${encodeURIComponent(uuid)}`),
  getRideTimeseries: (uuid: string, bucketSeconds = 15) =>
    requestJson<{
      ride_uuid: string;
      name: string;
      bucket_seconds: number;
      raw_samples: number;
      points: {
        t_s: number;
        watts: number | null;
        hr_bpm: number | null;
        cadence_rpm: number | null;
        speed_kph: number | null;
      }[];
    }>(`/api/rides/${encodeURIComponent(uuid)}/timeseries?bucket_seconds=${bucketSeconds}`),
  retryStravaUpload: (uuid: string) =>
    requestJson<{
      ride_uuid: string;
      status: string;
      upload_id: string | null;
      error: string | null;
    }>(`/api/strava/retry/${encodeURIComponent(uuid)}`, { method: "POST" }),
  patchRide: (uuid: string, payload: { rpe?: number | null; feel?: number | null; notes?: string }) =>
    requestJson<{ ride: RideRecord }>(`/api/rides/${uuid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  uploadRideMultipart: (summary: RideUploadSummary, fitFile: Blob) => {
    const form = new FormData();
    form.append("summary", JSON.stringify(summary));
    form.append("fit", fitFile, `${summary.ride_uuid}.fit`);
    return requestJson<{ ride_uuid: string; idempotent: boolean }>("/api/rides", {
      method: "POST",
      body: form,
    });
  },

  getFitnessOverview: (days = 42) =>
    requestJson<FitnessOverviewResponse>(`/api/fitness/overview?days=${days}`),

  getRoutes: () => requestJson<{ routes: RouteRecord[] }>("/api/routes"),
  getRoute: (id: string) =>
    requestJson<{ route: RouteRecord; points: RoutePoint[] }>(
      `/api/routes/${encodeURIComponent(id)}`
    ),
  uploadGpxRoute: (gpxXml: string, name?: string) =>
    requestJson<{ route: RouteRecord; points: RoutePoint[] }>("/api/routes/gpx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gpx_xml: gpxXml, name }),
    }),
  extractRouteFromRide: (rideUuid: string) =>
    requestJson<{ route: RouteRecord; points: RoutePoint[] }>(
      `/api/routes/from-ride/${encodeURIComponent(rideUuid)}`,
      { method: "POST" }
    ),
  deleteRoute: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/routes/${encodeURIComponent(id)}`, { method: "DELETE" }),

  getStravaStatus: () =>
    requestJson<{
      configured: boolean;
      connected: boolean;
      athlete_external_id: string | null;
    }>("/api/strava/status").catch(() => ({
      configured: false,
      connected: false,
      athlete_external_id: null,
    })),

  getGarminStatus: () =>
    requestJson<{
      connected: boolean;
      last_sync_at: string | null;
      last_error: string | null;
      token_expires_at: number | null;
    }>("/api/garmin/status").catch(() => ({
      connected: false,
      last_sync_at: null,
      last_error: null,
      token_expires_at: null,
    })),
  connectGarmin: (apiKey: string) =>
    requestJson<{
      ok: boolean;
      status: {
        connected: boolean;
        last_sync_at: string | null;
        last_error: string | null;
        token_expires_at: number | null;
      };
    }>("/api/garmin/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    }),
  syncGarminNow: (days = 7) =>
    requestJson<{
      ok: boolean;
      rate_limited: boolean;
      retry_after_s?: number | null;
      start_date?: string;
      end_date?: string;
      activities_imported: number;
      activities_skipped: number;
      biometrics_upserted: number;
      error: string | null;
    }>("/api/garmin/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ days }),
    }),
  syncGarminRange: (startDate: string, endDate: string, skipPmcRecompute = true) =>
    requestJson<{
      ok: boolean;
      rate_limited: boolean;
      retry_after_s?: number | null;
      start_date: string;
      end_date: string;
      activities_imported: number;
      activities_skipped: number;
      biometrics_upserted: number;
      error: string | null;
    }>("/api/garmin/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        start_date: startDate,
        end_date: endDate,
        skip_pmc_recompute: skipPmcRecompute,
      }),
    }),
  rebuildPmc: () =>
    requestJson<{ ok: boolean; days_computed?: number }>("/api/import/rebuild-pmc", {
      method: "POST",
    }),
  disconnectGarmin: () =>
    requestJson<{ ok: boolean }>("/api/garmin/disconnect", { method: "DELETE" }),

  getBiometrics: (days = 30) =>
    requestJson<{
      days: number;
      summary: {
        latest: {
          day: string;
          hrv_rmssd_ms: number | null;
          hrv_status: string | null;
          resting_hr_bpm: number | null;
          sleep_duration_s: number | null;
          sleep_score: number | null;
          body_battery_high: number | null;
          weight_kg: number | null;
        } | null;
        hrv_7d_avg: number | null;
        hrv_baseline_avg: number | null;
        hrv_delta_pct: number | null;
        resting_hr_7d_avg: number | null;
        sleep_hours_7d_avg: number | null;
        sleep_score_7d_avg: number | null;
      };
      biometrics: {
        day: string;
        hrv_rmssd_ms: number | null;
        resting_hr_bpm: number | null;
        sleep_duration_s: number | null;
        sleep_score: number | null;
        body_battery_high: number | null;
      }[];
    }>(`/api/fitness/biometrics?days=${days}`).catch(() => null),
};
