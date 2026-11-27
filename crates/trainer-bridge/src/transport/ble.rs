use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::StreamExt;
use tokio::sync::{Notify, RwLock};
use tokio::task::AbortHandle;
use zbus::Connection;
use zbus::fdo::{ObjectManagerProxy, PropertiesProxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::protocol::{SensorConnectionState, SensorStatus};
use crate::transport::ble_parse::{
    CYCLING_POWER_MEASUREMENT_UUID, CYCLING_POWER_SERVICE_UUID, FTMS_CONTROL_POINT_UUID,
    FTMS_INDOOR_BIKE_DATA_UUID, FTMS_SERVICE_UUID, HR_MEASUREMENT_UUID, HR_SERVICE_UUID,
    cadence_from_crank_events, encode_request_control, encode_set_indoor_bike_simulation,
    encode_set_resistance_pct, encode_set_target_power, encode_start_or_resume,
    parse_cycling_power_measurement, parse_heart_rate_measurement, parse_indoor_bike_data,
};
use crate::transport::{RawSensorSample, TrainerTransport};

const BLUEZ_SERVICE: &str = "org.bluez";
const ADAPTER_IFACE: &str = "org.bluez.Adapter1";
const DEVICE_IFACE: &str = "org.bluez.Device1";
const GATT_CHAR_IFACE: &str = "org.bluez.GattCharacteristic1";
const SAMPLE_STALE_AFTER: Duration = Duration::from_secs(6);
const CRANK_STALE_AFTER: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredBleDevice {
    pub object_path: String,
    pub address: String,
    pub name: String,
    pub connected: bool,
    pub is_ftms: bool,
    pub is_cps: bool,
    pub is_hr: bool,
}

#[derive(Debug, Default)]
struct BleSharedState {
    sample: RawSensorSample,
    trainer_last_seen: Option<Instant>,
    hr_last_seen: Option<Instant>,
    last_crank_event: Option<(u16, u16)>,
    last_crank_changed_at: Option<Instant>,
    trainer_connected: bool,
    hr_connected: bool,
    trainer_device_path: Option<String>,
    hr_device_path: Option<String>,
    control_point: Option<(Connection, OwnedObjectPath)>,
    subscribed_chars: HashMap<String, NotifySubscription>,
    next_subscription_id: u64,
}

#[derive(Debug)]
struct NotifySubscription {
    id: u64,
    kind: NotifyKind,
    abort_handle: AbortHandle,
}

pub struct BleTransport {
    state: Arc<RwLock<BleSharedState>>,
    scan_notify: Arc<Notify>,
}

impl BleTransport {
    pub fn new() -> Self {
        let state = Arc::new(RwLock::new(BleSharedState::default()));
        let scan_notify = Arc::new(Notify::new());
        let state_bg = Arc::clone(&state);
        let notify_bg = Arc::clone(&scan_notify);

        tokio::spawn(async move {
            ble_supervisor_loop(state_bg, notify_bg).await;
        });

        Self { state, scan_notify }
    }

    async fn write_control_point(&self, payload: Vec<u8>) -> anyhow::Result<()> {
        let cp = {
            let guard = self.state.read().await;
            guard.control_point.clone()
        };

        let Some((conn, path)) = cp else {
            tracing::debug!("BLE FTMS control point not connected yet; skipping command write");
            return Ok(());
        };

        if let Err(first_err) = gatt_write_value(&conn, &path, &payload).await {
            tracing::warn!(error = %first_err, "FTMS write failed; re-requesting control and retrying");
            let req = encode_request_control()?;
            let _ = gatt_write_value(&conn, &path, &req).await;
            gatt_write_value(&conn, &path, &payload).await?;
        }
        Ok(())
    }
}

impl Default for BleTransport {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl TrainerTransport for BleTransport {
    fn transport_name(&self) -> &'static str {
        "ble"
    }

    async fn read_sample(&self) -> (RawSensorSample, SensorStatus) {
        let guard = self.state.read().await;
        let status = SensorStatus {
            trainer: if guard.trainer_connected {
                SensorConnectionState::Connected
            } else {
                SensorConnectionState::Disconnected
            },
            hr: if guard.hr_connected {
                SensorConnectionState::Connected
            } else {
                SensorConnectionState::Disconnected
            },
            transport: "ble".to_string(),
        };

        (guard.sample, status)
    }

    async fn set_erg_watts(&self, watts: u16) -> anyhow::Result<()> {
        let payload = encode_set_target_power(watts)?;
        self.write_control_point(payload).await
    }

    async fn set_slope_grade(&self, grade_pct: f64) -> anyhow::Result<()> {
        let payload = encode_set_indoor_bike_simulation(grade_pct)?;
        self.write_control_point(payload).await
    }

    async fn set_resistance_pct(&self, pct: f64) -> anyhow::Result<()> {
        let payload = encode_set_resistance_pct(pct)?;
        self.write_control_point(payload).await
    }

    async fn scan_sensors(&self) -> anyhow::Result<()> {
        self.scan_notify.notify_one();
        Ok(())
    }
}

pub async fn probe_ble_devices(seconds: u64) -> anyhow::Result<Vec<DiscoveredBleDevice>> {
    let conn = Connection::system().await?;
    let obj_mgr = ObjectManagerProxy::builder(&conn)
        .destination(BLUEZ_SERVICE)?
        .path("/")?
        .build()
        .await?;

    let initial_objects = obj_mgr.get_managed_objects().await?;
    let adapter_path = find_first_adapter(&initial_objects).ok_or_else(|| {
        anyhow::anyhow!("No BlueZ Bluetooth adapter found on D-Bus (org.bluez.Adapter1)")
    })?;

    let adapter_proxy = zbus::Proxy::new(&conn, BLUEZ_SERVICE, adapter_path, ADAPTER_IFACE).await?;
    let _ = adapter_proxy.call::<_, _, ()>("StartDiscovery", &()).await;

    tokio::time::sleep(Duration::from_secs(seconds.clamp(1, 30))).await;

    let _ = adapter_proxy.call::<_, _, ()>("StopDiscovery", &()).await;
    let objects = obj_mgr.get_managed_objects().await?;
    let mut devices = extract_relevant_devices(&objects);
    devices.sort_by(|a, b| {
        b.connected
            .cmp(&a.connected)
            .then_with(|| b.is_ftms.cmp(&a.is_ftms))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(devices)
}

async fn ble_supervisor_loop(state: Arc<RwLock<BleSharedState>>, scan_notify: Arc<Notify>) {
    loop {
        let conn = match Connection::system().await {
            Ok(c) => c,
            Err(err) => {
                tracing::warn!(error = %err, "System D-Bus unavailable for BLE transport; retrying in 5s");
                tokio::time::sleep(Duration::from_secs(5)).await;
                continue;
            }
        };

        if let Err(err) = run_ble_session(&conn, &state, &scan_notify).await {
            tracing::warn!(error = %err, "BLE supervisor cycle error; retrying in 4s");
            tokio::time::sleep(Duration::from_secs(4)).await;
        }
    }
}

fn is_device_connected_in_objects(
    objects: &zbus::fdo::ManagedObjects,
    device_path: Option<&str>,
) -> bool {
    let Some(path_str) = device_path else {
        return false;
    };
    let Ok(obj_path) = OwnedObjectPath::try_from(path_str) else {
        return false;
    };
    let Ok(dev_iface) = zbus::names::InterfaceName::try_from(DEVICE_IFACE) else {
        return false;
    };
    objects
        .get(&obj_path)
        .and_then(|ifaces| ifaces.get(&dev_iface))
        .and_then(|props| props.get("Connected"))
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}

async fn run_ble_session(
    conn: &Connection,
    state: &Arc<RwLock<BleSharedState>>,
    scan_notify: &Arc<Notify>,
) -> anyhow::Result<()> {
    let obj_mgr = ObjectManagerProxy::builder(conn)
        .destination(BLUEZ_SERVICE)?
        .path("/")?
        .build()
        .await?;

    let mut cycle: u32 = 0;
    let mut manual_scan_requested = false;

    loop {
        let mut objects = obj_mgr.get_managed_objects().await?;
        let Some(adapter_path) = find_first_adapter(&objects) else {
            tracing::debug!("No BlueZ adapter available yet");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };

        // Reconcile actual BlueZ connection state on every cycle so disconnects are detected immediately
        let (need_trainer, need_hr) = {
            let mut guard = state.write().await;
            if guard.trainer_connected
                && !is_device_connected_in_objects(&objects, guard.trainer_device_path.as_deref())
            {
                tracing::info!("FTMS trainer disconnected in BlueZ");
                let device_path = guard.trainer_device_path.clone();
                clear_device_subscriptions(&mut guard, device_path.as_deref(), true);
                clear_trainer_state(&mut guard);
            }
            if guard.hr_connected
                && !is_device_connected_in_objects(&objects, guard.hr_device_path.as_deref())
            {
                tracing::info!("BLE Heart Rate sensor disconnected in BlueZ");
                let device_path = guard.hr_device_path.clone();
                clear_device_subscriptions(&mut guard, device_path.as_deref(), false);
                clear_hr_state(&mut guard);
            }
            (!guard.trainer_connected, !guard.hr_connected)
        };

        if need_trainer || need_hr {
            let known_before = extract_relevant_devices(&objects);
            let missing_trainer =
                need_trainer && !known_before.iter().any(|d| d.is_ftms || d.is_cps);
            let missing_hr = need_hr && !known_before.iter().any(|d| d.is_hr);
            let run_discovery =
                manual_scan_requested || missing_trainer || missing_hr || cycle.is_multiple_of(4);
            manual_scan_requested = false;

            if run_discovery
                && let Ok(adapter) =
                    zbus::Proxy::new(conn, BLUEZ_SERVICE, adapter_path.clone(), ADAPTER_IFACE).await
            {
                let discovery_started = adapter
                    .call::<_, _, ()>("StartDiscovery", &())
                    .await
                    .is_ok();
                tokio::time::sleep(Duration::from_secs(3)).await;
                // Stop discovery before initiating GATT connections to avoid BlueZ
                // le-connection-abort-by-local / InProgress errors on combo BT adapters.
                if discovery_started {
                    let _ = adapter.call::<_, _, ()>("StopDiscovery", &()).await;
                }
                objects = obj_mgr.get_managed_objects().await?;
            }

            let mut candidates = extract_relevant_devices(&objects);
            candidates.sort_by(|a, b| b.is_ftms.cmp(&a.is_ftms).then_with(|| a.name.cmp(&b.name)));
            for dev in candidates {
                let (still_need_trainer, still_need_hr) = {
                    let guard = state.read().await;
                    (!guard.trainer_connected, !guard.hr_connected)
                };
                let want_trainer = still_need_trainer && (dev.is_ftms || dev.is_cps);
                let want_hr = still_need_hr && dev.is_hr;
                if !want_trainer && !want_hr {
                    continue;
                }
                if let Err(err) = ensure_device_connected(conn, &dev).await {
                    tracing::warn!(
                        device = %dev.name,
                        address = %dev.address,
                        error = %err,
                        "BLE connect failed"
                    );
                    continue;
                }
                let post_connect_objects = obj_mgr.get_managed_objects().await?;
                bind_device_characteristics(
                    conn,
                    &dev,
                    &post_connect_objects,
                    state,
                    want_trainer,
                    want_hr,
                )
                .await;
            }
        }

        cycle = cycle.wrapping_add(1);
        tokio::select! {
            _ = scan_notify.notified() => {
                tracing::info!("Manual BLE sensor rescan requested");
                manual_scan_requested = true;
            }
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

async fn ensure_device_connected(
    conn: &Connection,
    dev: &DiscoveredBleDevice,
) -> anyhow::Result<()> {
    let props = PropertiesProxy::builder(conn)
        .destination(BLUEZ_SERVICE)?
        .path(dev.object_path.as_str())?
        .build()
        .await?;
    let iface_name: zbus::names::InterfaceName<'_> = DEVICE_IFACE.try_into()?;

    let already_connected = props
        .get(iface_name.clone(), "Connected")
        .await
        .ok()
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(dev.connected);

    if !already_connected {
        let dev_proxy =
            zbus::Proxy::new(conn, BLUEZ_SERVICE, dev.object_path.as_str(), DEVICE_IFACE).await?;
        tokio::time::timeout(
            Duration::from_secs(10),
            dev_proxy.call::<_, _, ()>("Connect", &()),
        )
        .await??;
    }

    for _ in 0..30 {
        let is_conn = props
            .get(iface_name.clone(), "Connected")
            .await
            .ok()
            .and_then(|v| bool::try_from(v).ok())
            .unwrap_or(false);
        if !is_conn {
            anyhow::bail!("Device disconnected while resolving GATT services");
        }
        let resolved = props
            .get(iface_name.clone(), "ServicesResolved")
            .await
            .ok()
            .and_then(|v| bool::try_from(v).ok())
            .unwrap_or(false);
        if resolved {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    anyhow::bail!("Timed out waiting for BlueZ ServicesResolved=true");
}

async fn bind_device_characteristics(
    conn: &Connection,
    dev: &DiscoveredBleDevice,
    objects: &zbus::fdo::ManagedObjects,
    state: &Arc<RwLock<BleSharedState>>,
    want_trainer: bool,
    want_hr: bool,
) {
    let chars = find_device_characteristics(objects, &dev.object_path);

    if want_trainer && (dev.is_ftms || dev.is_cps) {
        if dev.is_ftms
            && let Some(cp_path) = chars.get(FTMS_CONTROL_POINT_UUID)
        {
            let mut cp_ok = false;
            if let Ok(cp_proxy) =
                zbus::Proxy::new(conn, BLUEZ_SERVICE, cp_path.clone(), GATT_CHAR_IFACE).await
            {
                let _ = cp_proxy.call::<_, _, ()>("StartNotify", &()).await;
            }
            if let Ok(req) = encode_request_control() {
                cp_ok = gatt_write_value(conn, cp_path, &req).await.is_ok();
            }
            if let Ok(start) = encode_start_or_resume() {
                let _ = gatt_write_value(conn, cp_path, &start).await;
            }
            let mut guard = state.write().await;
            guard.control_point = Some((conn.clone(), cp_path.clone()));
            guard.trainer_connected = true;
            guard.trainer_device_path = Some(dev.object_path.clone());
            tracing::info!(
                device = %dev.name,
                address = %dev.address,
                control_acquired = cp_ok,
                "Connected FTMS trainer control point"
            );
        }

        if let Some(ibd_path) = chars.get(FTMS_INDOOR_BIKE_DATA_UUID) {
            spawn_notify_listener(
                conn.clone(),
                ibd_path.clone(),
                dev.object_path.clone(),
                dev.name.clone(),
                NotifyKind::FtmsIndoorBike,
                Arc::clone(state),
            )
            .await;
        } else if let Some(cps_path) = chars.get(CYCLING_POWER_MEASUREMENT_UUID) {
            spawn_notify_listener(
                conn.clone(),
                cps_path.clone(),
                dev.object_path.clone(),
                dev.name.clone(),
                NotifyKind::CyclingPower,
                Arc::clone(state),
            )
            .await;
        }
    }

    if want_hr
        && dev.is_hr
        && let Some(hr_path) = chars.get(HR_MEASUREMENT_UUID)
    {
        spawn_notify_listener(
            conn.clone(),
            hr_path.clone(),
            dev.object_path.clone(),
            dev.name.clone(),
            NotifyKind::HeartRate,
            Arc::clone(state),
        )
        .await;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotifyKind {
    FtmsIndoorBike,
    CyclingPower,
    HeartRate,
}

impl NotifyKind {
    fn is_trainer(self) -> bool {
        matches!(self, Self::FtmsIndoorBike | Self::CyclingPower)
    }
}

fn clear_trainer_state(state: &mut BleSharedState) {
    state.trainer_connected = false;
    state.trainer_device_path = None;
    state.trainer_last_seen = None;
    state.last_crank_event = None;
    state.last_crank_changed_at = None;
    state.control_point = None;
    state.sample.watts = None;
    state.sample.cadence_rpm = None;
    state.sample.speed_kph = None;
}

fn clear_hr_state(state: &mut BleSharedState) {
    state.hr_connected = false;
    state.hr_device_path = None;
    state.hr_last_seen = None;
    state.sample.hr_bpm = None;
}

fn clear_device_subscriptions(
    state: &mut BleSharedState,
    device_path: Option<&str>,
    trainer_only: bool,
) {
    let Some(device_path) = device_path else {
        return;
    };
    let prefix = format!("{device_path}/");
    let keys = state
        .subscribed_chars
        .iter()
        .filter(|(path, sub)| path.starts_with(&prefix) && sub.kind.is_trainer() == trainer_only)
        .map(|(path, _)| path.clone())
        .collect::<Vec<_>>();
    for key in keys {
        if let Some(subscription) = state.subscribed_chars.remove(&key) {
            subscription.abort_handle.abort();
        }
    }
}

async fn spawn_notify_listener(
    conn: Connection,
    char_path: OwnedObjectPath,
    device_path: String,
    device_name: String,
    kind: NotifyKind,
    state: Arc<RwLock<BleSharedState>>,
) {
    let key = char_path.as_str().to_string();
    let mut guard = state.write().await;
    if guard.subscribed_chars.contains_key(&key) {
        return;
    }

    guard.next_subscription_id = guard.next_subscription_id.wrapping_add(1);
    let subscription_id = guard.next_subscription_id;
    let listener_state = Arc::clone(&state);
    let listener_key = key.clone();
    let handle = tokio::spawn(async move {
        if let Err(err) = run_notify_listener(
            &conn,
            &char_path,
            &device_path,
            &device_name,
            kind,
            &listener_state,
        )
        .await
        {
            tracing::warn!(
                device = %device_name,
                characteristic = %listener_key,
                error = %err,
                "BLE GATT notify stream ended"
            );
        }
        let mut guard = listener_state.write().await;
        let is_current = guard
            .subscribed_chars
            .get(&listener_key)
            .is_some_and(|subscription| subscription.id == subscription_id);
        if !is_current {
            return;
        }
        guard.subscribed_chars.remove(&listener_key);
        if kind.is_trainer() {
            clear_trainer_state(&mut guard);
        } else {
            clear_hr_state(&mut guard);
        }
    });
    guard.subscribed_chars.insert(
        key,
        NotifySubscription {
            id: subscription_id,
            kind,
            abort_handle: handle.abort_handle(),
        },
    );
}

fn apply_notify_bytes_to_state(
    guard: &mut BleSharedState,
    kind: NotifyKind,
    bytes: &[u8],
    logged_first: &mut bool,
    device_name: &str,
    now: Instant,
) {
    match kind {
        NotifyKind::FtmsIndoorBike => {
            if let Ok(parsed) = parse_indoor_bike_data(bytes) {
                if let Some(w) = parsed.watts {
                    guard.sample.watts = Some(w);
                }
                if let Some(cad) = parsed.cadence_rpm {
                    guard.sample.cadence_rpm = Some(cad);
                }
                if let Some(spd) = parsed.speed_kph {
                    guard.sample.speed_kph = Some(spd);
                }
                if let Some(hr) = parsed.hr_bpm
                    && guard
                        .hr_last_seen
                        .is_none_or(|ts| now.saturating_duration_since(ts) > SAMPLE_STALE_AFTER)
                {
                    guard.sample.hr_bpm = Some(hr);
                }
                guard.trainer_last_seen = Some(now);
                guard.trainer_connected = true;
                if !*logged_first {
                    *logged_first = true;
                    tracing::info!(
                        device = %device_name,
                        watts = ?parsed.watts,
                        cadence = ?parsed.cadence_rpm,
                        speed_kph = ?parsed.speed_kph,
                        "Receiving FTMS Indoor Bike Data telemetry"
                    );
                }
            }
        }
        NotifyKind::CyclingPower => {
            if let Some(parsed) = parse_cycling_power_measurement(bytes) {
                guard.sample.watts = Some(parsed.watts);
                if let (Some(revs), Some(event_time)) =
                    (parsed.crank_revolutions, parsed.crank_event_time)
                {
                    let current = (revs, event_time);
                    if let Some(previous) = guard.last_crank_event {
                        if let Some(rpm) = cadence_from_crank_events(previous, current) {
                            guard.sample.cadence_rpm = Some(rpm);
                            guard.last_crank_changed_at = Some(now);
                        } else if guard.last_crank_changed_at.is_some_and(|changed_at| {
                            now.saturating_duration_since(changed_at) >= CRANK_STALE_AFTER
                        }) {
                            guard.sample.cadence_rpm = Some(0);
                        }
                    } else {
                        guard.last_crank_changed_at = Some(now);
                    }
                    guard.last_crank_event = Some(current);
                }
                guard.trainer_last_seen = Some(now);
                guard.trainer_connected = true;
                if !*logged_first {
                    *logged_first = true;
                    tracing::info!(
                        device = %device_name,
                        watts = parsed.watts,
                        cadence = ?guard.sample.cadence_rpm,
                        "Receiving BLE Cycling Power telemetry"
                    );
                }
            }
        }
        NotifyKind::HeartRate => {
            if let Some(hr) = parse_heart_rate_measurement(bytes) {
                guard.sample.hr_bpm = Some(hr);
                guard.hr_last_seen = Some(now);
                guard.hr_connected = true;
                if !*logged_first {
                    *logged_first = true;
                    tracing::info!(
                        device = %device_name,
                        hr_bpm = hr,
                        "Receiving BLE Heart Rate telemetry"
                    );
                }
            }
        }
    }
}

async fn apply_notify_bytes(
    state: &Arc<RwLock<BleSharedState>>,
    kind: NotifyKind,
    bytes: &[u8],
    logged_first: &mut bool,
    device_name: &str,
) {
    let mut guard = state.write().await;
    apply_notify_bytes_to_state(
        &mut guard,
        kind,
        bytes,
        logged_first,
        device_name,
        Instant::now(),
    );
}

async fn run_notify_listener(
    conn: &Connection,
    char_path: &OwnedObjectPath,
    device_path: &str,
    device_name: &str,
    kind: NotifyKind,
    state: &Arc<RwLock<BleSharedState>>,
) -> anyhow::Result<()> {
    let props = PropertiesProxy::builder(conn)
        .destination(BLUEZ_SERVICE)?
        .path(char_path.clone())?
        .build()
        .await?;
    let mut stream = props.receive_properties_changed().await?;

    let char_proxy =
        zbus::Proxy::new(conn, BLUEZ_SERVICE, char_path.clone(), GATT_CHAR_IFACE).await?;
    char_proxy.call::<_, _, ()>("StartNotify", &()).await?;

    {
        let mut guard = state.write().await;
        if kind.is_trainer() {
            guard.trainer_connected = true;
            guard.trainer_device_path = Some(device_path.to_string());
            guard.trainer_last_seen = Some(Instant::now());
        } else {
            guard.hr_connected = true;
            guard.hr_device_path = Some(device_path.to_string());
            guard.hr_last_seen = Some(Instant::now());
        }
    }
    tracing::info!(
        device = %device_name,
        characteristic = %char_path.as_str(),
        "Subscribed BLE GATT notifications"
    );

    let mut logged_first = false;
    if let Ok(char_iface) = zbus::names::InterfaceName::try_from(GATT_CHAR_IFACE)
        && let Ok(initial_val) = props.get(char_iface, "Value").await
    {
        let initial_bytes = extract_byte_array(&Value::from(initial_val));
        if !initial_bytes.is_empty() {
            apply_notify_bytes(state, kind, &initial_bytes, &mut logged_first, device_name).await;
        }
    }

    while let Some(signal) = stream.next().await {
        let Ok(args) = signal.args() else {
            continue;
        };
        let changed = args.changed_properties();
        let Some(val) = changed.get("Value") else {
            continue;
        };
        let bytes = extract_byte_array(val);
        if bytes.is_empty() {
            continue;
        }
        apply_notify_bytes(state, kind, &bytes, &mut logged_first, device_name).await;
    }

    Ok(())
}

async fn gatt_write_value(
    conn: &Connection,
    char_path: &OwnedObjectPath,
    payload: &[u8],
) -> anyhow::Result<()> {
    let char_proxy =
        zbus::Proxy::new(conn, BLUEZ_SERVICE, char_path.clone(), GATT_CHAR_IFACE).await?;
    let mut options: HashMap<&str, Value<'_>> = HashMap::new();
    options.insert("type", Value::from("request"));
    tokio::time::timeout(
        Duration::from_secs(5),
        char_proxy.call::<_, _, ()>("WriteValue", &(payload, options)),
    )
    .await??;
    Ok(())
}

fn find_first_adapter(objects: &zbus::fdo::ManagedObjects) -> Option<OwnedObjectPath> {
    let iface: zbus::names::InterfaceName<'_> = ADAPTER_IFACE.try_into().ok()?;
    objects
        .iter()
        .find(|(_, ifaces)| ifaces.contains_key(&iface))
        .map(|(path, _)| path.clone())
}

fn extract_relevant_devices(objects: &zbus::fdo::ManagedObjects) -> Vec<DiscoveredBleDevice> {
    let Ok(dev_iface) = zbus::names::InterfaceName::try_from(DEVICE_IFACE) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (path, ifaces) in objects {
        let Some(props) = ifaces.get(&dev_iface) else {
            continue;
        };
        let uuids = extract_string_array(props.get("UUIDs"))
            .into_iter()
            .map(|u| u.to_ascii_lowercase())
            .collect::<Vec<_>>();
        let is_ftms = uuids.iter().any(|u| u == FTMS_SERVICE_UUID);
        let is_cps = uuids.iter().any(|u| u == CYCLING_POWER_SERVICE_UUID);
        let is_hr = uuids.iter().any(|u| u == HR_SERVICE_UUID);
        if !is_ftms && !is_cps && !is_hr {
            continue;
        }

        let address = extract_string(props.get("Address")).unwrap_or_default();
        let name = extract_string(props.get("Name"))
            .or_else(|| extract_string(props.get("Alias")))
            .unwrap_or_else(|| address.clone());
        let connected = props
            .get("Connected")
            .and_then(|v| bool::try_from(v).ok())
            .unwrap_or(false);

        out.push(DiscoveredBleDevice {
            object_path: path.as_str().to_string(),
            address,
            name,
            connected,
            is_ftms,
            is_cps,
            is_hr,
        });
    }
    out
}

fn find_device_characteristics(
    objects: &zbus::fdo::ManagedObjects,
    device_path: &str,
) -> HashMap<String, OwnedObjectPath> {
    let mut map = HashMap::new();
    let Ok(char_iface) = zbus::names::InterfaceName::try_from(GATT_CHAR_IFACE) else {
        return map;
    };

    let prefix = format!("{device_path}/");
    for (path, ifaces) in objects {
        if !path.as_str().starts_with(&prefix) {
            continue;
        }
        let Some(props) = ifaces.get(&char_iface) else {
            continue;
        };
        if let Some(uuid) = extract_string(props.get("UUID")) {
            map.insert(uuid.to_ascii_lowercase(), path.clone());
        }
    }
    map
}

fn extract_string(val: Option<&OwnedValue>) -> Option<String> {
    let v = val?;
    let s: &str = v.downcast_ref().ok()?;
    Some(s.to_string())
}

fn extract_string_array(val: Option<&OwnedValue>) -> Vec<String> {
    let Some(v) = val else {
        return Vec::new();
    };
    Vec::<String>::try_from(v.clone()).unwrap_or_default()
}

fn extract_byte_array(val: &Value<'_>) -> Vec<u8> {
    match val {
        Value::Array(arr) => arr
            .iter()
            .filter_map(|item| match item {
                Value::U8(b) => Some(*b),
                _ => None,
            })
            .collect(),
        Value::Value(inner) => extract_byte_array(inner),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{
        BleSharedState, CRANK_STALE_AFTER, NotifyKind, apply_notify_bytes_to_state, clear_hr_state,
        clear_trainer_state, extract_byte_array,
    };
    use zbus::zvariant::Value;

    #[test]
    fn extract_byte_array_unwraps_direct_and_variant_arrays() {
        let direct = Value::from(vec![68u8, 0, 120, 0]);
        assert_eq!(extract_byte_array(&direct), vec![68, 0, 120, 0]);

        let wrapped = Value::Value(Box::new(Value::from(vec![0x06u8, 142])));
        assert_eq!(extract_byte_array(&wrapped), vec![0x06, 142]);
    }

    #[test]
    fn disconnect_clears_stale_sensor_samples() {
        let mut state = BleSharedState {
            trainer_connected: true,
            hr_connected: true,
            ..BleSharedState::default()
        };
        state.sample.watts = Some(240);
        state.sample.cadence_rpm = Some(92);
        state.sample.speed_kph = Some(33.5);
        state.sample.hr_bpm = Some(158);

        clear_trainer_state(&mut state);
        assert!(!state.trainer_connected);
        assert_eq!(state.sample.watts, None);
        assert_eq!(state.sample.cadence_rpm, None);
        assert_eq!(state.sample.speed_kph, None);
        assert_eq!(state.sample.hr_bpm, Some(158));

        clear_hr_state(&mut state);
        assert!(!state.hr_connected);
        assert_eq!(state.sample.hr_bpm, None);
    }

    #[test]
    fn cycling_power_cadence_holds_between_ticks_and_zeros_after_stale_timeout() {
        let mut state = BleSharedState::default();
        let mut logged_first = false;
        let t0 = Instant::now();

        let p1 = [0x20, 0x00, 0xc8, 0x00, 10, 0, 0, 0];
        let p2 = [0x20, 0x00, 0xc8, 0x00, 11, 0, 0, 4]; // +1 rev in 1024 ticks = 60 rpm
        apply_notify_bytes_to_state(
            &mut state,
            NotifyKind::CyclingPower,
            &p1,
            &mut logged_first,
            "PowerMeter",
            t0,
        );
        apply_notify_bytes_to_state(
            &mut state,
            NotifyKind::CyclingPower,
            &p2,
            &mut logged_first,
            "PowerMeter",
            t0 + Duration::from_secs(1),
        );
        assert_eq!(state.sample.watts, Some(200));
        assert_eq!(state.sample.cadence_rpm, Some(60));

        // Repeated crank event 250ms later must NOT drop cadence to 0
        apply_notify_bytes_to_state(
            &mut state,
            NotifyKind::CyclingPower,
            &p2,
            &mut logged_first,
            "PowerMeter",
            t0 + Duration::from_millis(1250),
        );
        assert_eq!(state.sample.cadence_rpm, Some(60));

        // Repeated crank event after CRANK_STALE_AFTER drops cadence cleanly to 0
        apply_notify_bytes_to_state(
            &mut state,
            NotifyKind::CyclingPower,
            &p2,
            &mut logged_first,
            "PowerMeter",
            t0 + Duration::from_secs(1) + CRANK_STALE_AFTER,
        );
        assert_eq!(state.sample.cadence_rpm, Some(0));
    }
}
