use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures_util::StreamExt;
use tokio::sync::{Notify, RwLock};
use zbus::Connection;
use zbus::fdo::{ObjectManagerProxy, PropertiesProxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::protocol::{SensorConnectionState, SensorStatus};
use crate::transport::ble_parse::{
    FTMS_CONTROL_POINT_UUID, FTMS_INDOOR_BIKE_DATA_UUID, FTMS_SERVICE_UUID, HR_MEASUREMENT_UUID,
    HR_SERVICE_UUID, encode_request_control, encode_set_indoor_bike_simulation,
    encode_set_resistance_pct, encode_set_target_power, encode_start_or_resume,
    parse_heart_rate_measurement, parse_indoor_bike_data,
};
use crate::transport::{RawSensorSample, TrainerTransport};

const BLUEZ_SERVICE: &str = "org.bluez";
const ADAPTER_IFACE: &str = "org.bluez.Adapter1";
const DEVICE_IFACE: &str = "org.bluez.Device1";
const GATT_CHAR_IFACE: &str = "org.bluez.GattCharacteristic1";
const SAMPLE_STALE_AFTER: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredBleDevice {
    pub object_path: String,
    pub address: String,
    pub name: String,
    pub connected: bool,
    pub is_ftms: bool,
    pub is_hr: bool,
}

#[derive(Debug, Default)]
struct BleSharedState {
    sample: RawSensorSample,
    trainer_last_seen: Option<Instant>,
    hr_last_seen: Option<Instant>,
    trainer_connected: bool,
    hr_connected: bool,
    control_point: Option<(Connection, OwnedObjectPath)>,
    subscribed_chars: HashSet<String>,
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
        let trainer_fresh = guard.trainer_connected
            && guard
                .trainer_last_seen
                .is_some_and(|ts| ts.elapsed() <= SAMPLE_STALE_AFTER);
        let hr_fresh = guard.hr_connected
            && guard
                .hr_last_seen
                .is_some_and(|ts| ts.elapsed() <= SAMPLE_STALE_AFTER);

        let status = SensorStatus {
            trainer: if trainer_fresh {
                SensorConnectionState::Connected
            } else {
                SensorConnectionState::Disconnected
            },
            hr: if hr_fresh {
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

    loop {
        let objects = obj_mgr.get_managed_objects().await?;
        let Some(adapter_path) = find_first_adapter(&objects) else {
            tracing::debug!("No BlueZ adapter available yet");
            tokio::time::sleep(Duration::from_secs(5)).await;
            continue;
        };

        let (need_trainer, need_hr) = {
            let guard = state.read().await;
            let trainer_ok = guard.trainer_connected
                && guard
                    .trainer_last_seen
                    .is_some_and(|ts| ts.elapsed() <= SAMPLE_STALE_AFTER);
            let hr_ok = guard.hr_connected
                && guard
                    .hr_last_seen
                    .is_some_and(|ts| ts.elapsed() <= SAMPLE_STALE_AFTER);
            (!trainer_ok, !hr_ok)
        };

        if need_trainer || need_hr {
            if let Ok(adapter) =
                zbus::Proxy::new(conn, BLUEZ_SERVICE, adapter_path.clone(), ADAPTER_IFACE).await
            {
                let _ = adapter.call::<_, _, ()>("StartDiscovery", &()).await;
                tokio::time::sleep(Duration::from_secs(4)).await;
                let _ = adapter.call::<_, _, ()>("StopDiscovery", &()).await;
            }

            let refreshed = obj_mgr.get_managed_objects().await?;
            let candidates = extract_relevant_devices(&refreshed);

            for dev in candidates {
                let want_dev = (need_trainer && dev.is_ftms) || (need_hr && dev.is_hr);
                if !want_dev {
                    continue;
                }
                if let Err(err) = ensure_device_connected(conn, &dev).await {
                    tracing::debug!(device = %dev.name, address = %dev.address, error = %err, "BLE connect failed");
                    continue;
                }
                let post_connect_objects = obj_mgr.get_managed_objects().await?;
                bind_device_characteristics(conn, &dev, &post_connect_objects, state).await;
            }
        }

        tokio::select! {
            _ = scan_notify.notified() => {
                tracing::info!("Manual BLE sensor rescan requested");
            }
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
        }
    }
}

async fn ensure_device_connected(
    conn: &Connection,
    dev: &DiscoveredBleDevice,
) -> anyhow::Result<()> {
    let dev_proxy =
        zbus::Proxy::new(conn, BLUEZ_SERVICE, dev.object_path.as_str(), DEVICE_IFACE).await?;
    if !dev.connected {
        tokio::time::timeout(
            Duration::from_secs(10),
            dev_proxy.call::<_, _, ()>("Connect", &()),
        )
        .await??;
    }

    let props = PropertiesProxy::builder(conn)
        .destination(BLUEZ_SERVICE)?
        .path(dev.object_path.as_str())?
        .build()
        .await?;

    let iface_name: zbus::names::InterfaceName<'_> = DEVICE_IFACE.try_into()?;
    for _ in 0..20 {
        if let Ok(val) = props.get(iface_name.clone(), "ServicesResolved").await
            && bool::try_from(val).unwrap_or(false)
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    Ok(())
}

async fn bind_device_characteristics(
    conn: &Connection,
    dev: &DiscoveredBleDevice,
    objects: &zbus::fdo::ManagedObjects,
    state: &Arc<RwLock<BleSharedState>>,
) {
    let chars = find_device_characteristics(objects, &dev.object_path);

    if dev.is_ftms {
        if let Some(cp_path) = chars.get(FTMS_CONTROL_POINT_UUID) {
            if let Ok(cp_proxy) =
                zbus::Proxy::new(conn, BLUEZ_SERVICE, cp_path.clone(), GATT_CHAR_IFACE).await
            {
                let _ = cp_proxy.call::<_, _, ()>("StartNotify", &()).await;
            }
            if let Ok(req) = encode_request_control() {
                let _ = gatt_write_value(conn, cp_path, &req).await;
            }
            if let Ok(start) = encode_start_or_resume() {
                let _ = gatt_write_value(conn, cp_path, &start).await;
            }
            let mut guard = state.write().await;
            guard.control_point = Some((conn.clone(), cp_path.clone()));
            guard.trainer_connected = true;
            tracing::info!(device = %dev.name, address = %dev.address, "Connected FTMS trainer control point");
        }

        if let Some(ibd_path) = chars.get(FTMS_INDOOR_BIKE_DATA_UUID) {
            let key = ibd_path.as_str().to_string();
            let already = state.read().await.subscribed_chars.contains(&key);
            if !already {
                state.write().await.subscribed_chars.insert(key.clone());
                spawn_notify_listener(
                    conn.clone(),
                    ibd_path.clone(),
                    NotifyKind::FtmsIndoorBike,
                    Arc::clone(state),
                );
            }
        }
    }

    if dev.is_hr
        && let Some(hr_path) = chars.get(HR_MEASUREMENT_UUID)
    {
        let key = hr_path.as_str().to_string();
        let already = state.read().await.subscribed_chars.contains(&key);
        if !already {
            state.write().await.subscribed_chars.insert(key.clone());
            spawn_notify_listener(
                conn.clone(),
                hr_path.clone(),
                NotifyKind::HeartRate,
                Arc::clone(state),
            );
            tracing::info!(device = %dev.name, address = %dev.address, "Subscribed BLE Heart Rate sensor");
        }
    }
}

#[derive(Clone, Copy)]
enum NotifyKind {
    FtmsIndoorBike,
    HeartRate,
}

fn spawn_notify_listener(
    conn: Connection,
    char_path: OwnedObjectPath,
    kind: NotifyKind,
    state: Arc<RwLock<BleSharedState>>,
) {
    let key = char_path.as_str().to_string();
    tokio::spawn(async move {
        if let Err(err) = run_notify_listener(&conn, &char_path, kind, &state).await {
            tracing::warn!(characteristic = %key, error = %err, "BLE GATT notify stream ended");
        }
        let mut guard = state.write().await;
        guard.subscribed_chars.remove(&key);
        match kind {
            NotifyKind::FtmsIndoorBike => {
                guard.trainer_connected = false;
                guard.control_point = None;
            }
            NotifyKind::HeartRate => {
                guard.hr_connected = false;
            }
        }
    });
}

async fn run_notify_listener(
    conn: &Connection,
    char_path: &OwnedObjectPath,
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

        let mut guard = state.write().await;
        match kind {
            NotifyKind::FtmsIndoorBike => {
                if let Ok(parsed) = parse_indoor_bike_data(&bytes) {
                    if let Some(w) = parsed.watts {
                        guard.sample.watts = Some(w);
                    }
                    if let Some(cad) = parsed.cadence_rpm {
                        guard.sample.cadence_rpm = Some(cad);
                    }
                    if let Some(spd) = parsed.speed_kph {
                        guard.sample.speed_kph = Some(spd);
                    }
                    // Use trainer-relayed HR only when no dedicated chest strap is fresh
                    if let Some(hr) = parsed.hr_bpm
                        && guard
                            .hr_last_seen
                            .is_none_or(|ts| ts.elapsed() > SAMPLE_STALE_AFTER)
                    {
                        guard.sample.hr_bpm = Some(hr);
                    }
                    guard.trainer_last_seen = Some(Instant::now());
                    guard.trainer_connected = true;
                }
            }
            NotifyKind::HeartRate => {
                if let Some(hr) = parse_heart_rate_measurement(&bytes) {
                    guard.sample.hr_bpm = Some(hr);
                    guard.hr_last_seen = Some(Instant::now());
                    guard.hr_connected = true;
                }
            }
        }
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
        let is_hr = uuids.iter().any(|u| u == HR_SERVICE_UUID);
        if !is_ftms && !is_hr {
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
    if let Value::Array(arr) = val {
        return arr
            .iter()
            .filter_map(|item| match item {
                Value::U8(b) => Some(*b),
                _ => None,
            })
            .collect();
    }
    Vec::new()
}
