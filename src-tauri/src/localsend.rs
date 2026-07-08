//! LocalSend protocol (v2, HTTPS mode) — send clips to, and receive files from,
//! any LocalSend-compatible app (the real mobile/desktop app, unmodified) on
//! the same LAN.
//!
//! This implements the subset of the protocol needed for a simple push:
//! - UDP multicast discovery on 224.0.0.167:53317 (announce + peer registry).
//! - HTTPS API on port 53317: /info, /register, /prepare-upload, /upload,
//!   /cancel — self-signed cert, trust is by announced fingerprint (like the
//!   real apps), not a CA chain. A real device tested live over plain HTTP got
//!   "empty reply from server": its socket was doing a TLS handshake and our
//!   plaintext bytes didn't parse as one — confirming HTTPS is required, not
//!   optional, for interop with the actual app.
//!
//! Not implemented: the "download" (pull) API and a receive approval prompt —
//! incoming sends are auto-accepted (see the "LocalSend" tray toggle to
//! disable the whole subsystem). Field/endpoint details beyond what's been
//! tested live (see above) are still from memory of the protocol spec, not a
//! live reference, so further small corrections are plausible.

use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use rcgen::{generate_simple_self_signed, CertifiedKey};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Response, SslConfig};
use ureq::tls::TlsConfig;

use crate::store::{ClipboardEntry, Store};
use crate::{cap_text, is_image_path, new_id, now_millis, thumbnail_image_file};

const LOCALSEND_PORT: u16 = 53317;
const MULTICAST_ADDR: Ipv4Addr = Ipv4Addr::new(224, 0, 0, 167);
const PROTOCOL_VERSION: &str = "2.1";
const ANNOUNCE_INTERVAL: Duration = Duration::from_secs(5);
const PEER_TTL_MS: u64 = 15_000;
/// Text sends up to this size are turned back into a plain-text clip instead
/// of a file clip (so a "send text" from a phone pastes like normal copy/paste).
const TEXT_INLINE_MAX: u64 = 200_000;

/// Fast-then-backoff retry for the discovery/HTTPS-server bind loops. Toggling
/// the "LocalSend" tray switch off then back on has to actually work — a flat
/// multi-second retry after a transient rebind failure (e.g. the OS hasn't
/// fully released the port yet) would look exactly like "the toggle is
/// broken" even though it would have recovered on its own a moment later.
struct RetryBackoff(Duration);
impl RetryBackoff {
    fn new() -> Self {
        Self(Duration::from_millis(150))
    }
    fn sleep(&mut self) {
        thread::sleep(self.0);
        self.0 = (self.0 * 2).min(Duration::from_secs(5));
    }
    fn reset(&mut self) {
        self.0 = Duration::from_millis(150);
    }
}

/// Shared HTTPS client. `disable_verification` is required and correct here,
/// not a shortcut: every peer's cert is self-signed with no CA, and LocalSend's
/// trust model is "identify the device by its announced fingerprint," not
/// "validate a certificate chain" — there is no CA to validate against on a
/// spontaneous LAN pairing. A short connect timeout means a bad/unreachable
/// address (typo'd manual IP, phone that's asleep) fails in a few seconds
/// instead of hanging on the OS's own TCP connect timeout (which has no upper
/// bound by default and can run past a minute). `timeout_global` is a generous
/// safety net for a connection that stalls mid-transfer, not a cap on
/// legitimate large sends.
fn ls_agent() -> &'static ureq::Agent {
    static AGENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    AGENT.get_or_init(|| {
        let tls_config = TlsConfig::builder().disable_verification(true).build();
        let config = ureq::Agent::config_builder()
            .tls_config(tls_config)
            .timeout_connect(Some(Duration::from_secs(5)))
            .timeout_global(Some(Duration::from_secs(600)))
            .build();
        ureq::Agent::new_with_config(config)
    })
}

/// Generate (once) or load a persisted self-signed cert for our HTTPS server.
fn load_or_create_tls(store: &Store) -> (Vec<u8>, Vec<u8>) {
    let cert_path = store.data_dir.join("localsend_cert.pem");
    let key_path = store.data_dir.join("localsend_key.pem");
    if let (Ok(cert), Ok(key)) = (std::fs::read(&cert_path), std::fs::read(&key_path)) {
        if !cert.is_empty() && !key.is_empty() {
            return (cert, key);
        }
    }
    let CertifiedKey { cert, signing_key } =
        generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("generate self-signed LocalSend TLS cert");
    let cert_pem = cert.pem().into_bytes();
    let key_pem = signing_key.serialize_pem().into_bytes();
    let _ = std::fs::create_dir_all(&store.data_dir);
    let _ = std::fs::write(&cert_path, &cert_pem);
    let _ = std::fs::write(&key_path, &key_pem);
    (cert_pem, key_pem)
}

/// 128 bits of OS-backed randomness as hex, with no new RNG dependency:
/// `RandomState` seeds each hasher from the OS CSPRNG, so hashing nothing still
/// yields an unpredictable 64-bit value. Good enough for a device fingerprint /
/// upload token — neither is a security boundary here (LAN + auto-accept).
fn gen_random_hex32() -> String {
    let a = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    let b = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    format!("{a:016x}{b:016x}")
}

// ── Protocol types ──────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
struct DeviceInfo {
    alias: String,
    version: String,
    #[serde(rename = "deviceModel")]
    device_model: Option<String>,
    #[serde(rename = "deviceType")]
    device_type: Option<String>,
    fingerprint: String,
    // A real device's /info response omits both of these entirely (confirmed
    // live) — default to LocalSend's standard port/protocol when absent
    // rather than fail to parse.
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    protocol: Option<String>,
    #[serde(default)]
    download: bool,
}

#[derive(Serialize, Deserialize)]
struct AnnounceMsg {
    #[serde(flatten)]
    info: DeviceInfo,
    announce: bool,
}

#[derive(Serialize, Deserialize, Clone)]
struct FileMeta {
    id: String,
    #[serde(rename = "fileName")]
    file_name: String,
    size: u64,
    #[serde(rename = "fileType")]
    file_type: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct PrepareUploadMsg {
    info: DeviceInfo,
    files: HashMap<String, FileMeta>,
}

#[derive(Serialize, Deserialize)]
struct PrepareUploadResp {
    #[serde(rename = "sessionId")]
    session_id: String,
    files: HashMap<String, String>,
}

// ── Shared state ────────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
pub struct PeerInfo {
    fingerprint: String,
    alias: String,
    ip: String,
    port: u16,
    #[serde(rename = "deviceType")]
    device_type: Option<String>,
    #[serde(rename = "lastSeenMs")]
    last_seen_ms: u64,
}

/// A device we've successfully sent to before — a fallback quick-pick when
/// live discovery doesn't find anything.
#[derive(Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    ip: String,
    port: u16,
    alias: Option<String>,
    #[serde(rename = "lastUsedMs")]
    last_used_ms: u64,
}

struct PendingFile {
    token: String,
    clip_id: String,
    file_name: String,
    file_type: String,
    dest: PathBuf,
}

struct UploadSession {
    files: HashMap<String, PendingFile>,
}

pub struct LocalSendState {
    pub enabled: AtomicBool,
    fingerprint: String,
    alias: String,
    peers: Mutex<HashMap<String, PeerInfo>>,
    sessions: Mutex<HashMap<String, UploadSession>>,
}

impl LocalSendState {
    pub fn new(fingerprint: String, enabled: bool) -> Self {
        Self {
            enabled: AtomicBool::new(enabled),
            fingerprint,
            alias: "Clip".to_string(),
            peers: Mutex::new(HashMap::new()),
            sessions: Mutex::new(HashMap::new()),
        }
    }

    fn device_info(&self) -> DeviceInfo {
        DeviceInfo {
            alias: self.alias.clone(),
            version: PROTOCOL_VERSION.to_string(),
            device_model: Some("Windows".to_string()),
            device_type: Some("desktop".to_string()),
            fingerprint: self.fingerprint.clone(),
            port: Some(LOCALSEND_PORT),
            protocol: Some("https".to_string()),
            download: false,
        }
    }
}

/// Read (or create) the persisted device fingerprint, so this machine looks
/// like the same device across restarts instead of a new one each time.
pub fn load_or_create_fingerprint(store: &Store) -> String {
    if let Some(fp) = store.get_setting("localsend_fingerprint") {
        return fp;
    }
    let fp = gen_random_hex32();
    store.set_setting("localsend_fingerprint", &fp);
    fp
}

fn guess_mime(name: &str) -> String {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "txt" => "text/plain",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

fn parse_query(query: &str) -> HashMap<String, String> {
    query
        .split('&')
        .filter_map(|pair| {
            let mut it = pair.splitn(2, '=');
            let k = it.next()?.to_string();
            if k.is_empty() {
                return None;
            }
            Some((k, it.next().unwrap_or("").to_string()))
        })
        .collect()
}

// ── Tauri commands (frontend-facing) ─────────────────────────────────────────

#[tauri::command]
pub fn localsend_list_peers(app: AppHandle) -> Vec<PeerInfo> {
    let state = app.state::<LocalSendState>();
    let cutoff = now_millis().saturating_sub(PEER_TTL_MS);
    let mut peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
    peers.retain(|_, p| p.last_seen_ms >= cutoff);
    peers.values().cloned().collect()
}

/// Report a send's outcome to the frontend. `#[tauri::command]` functions
/// without the `async` keyword run *inline* on whatever thread dispatches IPC
/// (almost certainly the UI thread) — so `localsend_send`/`localsend_send_to_ip`
/// return immediately and do the actual (blocking, potentially slow) network
/// work on a spawned thread, exactly like `downloader::start_download` does.
/// Doing the ureq calls directly in the command body froze — and, since a
/// long-unresponsive window commonly gets force-terminated by Windows or the
/// user, effectively crashed — the whole app when a target IP didn't respond.
fn emit_send_result(app: &AppHandle, result: Result<(), String>) {
    let payload = match result {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(message) => serde_json::json!({ "ok": false, "message": message }),
    };
    let _ = app.emit("localsend-send-result", payload);
}

/// Send a clip to a previously-discovered peer (by fingerprint).
#[tauri::command]
pub fn localsend_send(app: AppHandle, id: String, fingerprint: String) {
    thread::spawn(move || {
        let result = (|| {
            let (ip, port) = {
                let state = app.state::<LocalSendState>();
                let peers = state.peers.lock().unwrap_or_else(|e| e.into_inner());
                let p = peers
                    .get(&fingerprint)
                    .ok_or_else(|| "That device is no longer nearby.".to_string())?;
                (p.ip.clone(), p.port)
            };
            send_clip_to(&app, &id, &ip, port)
        })();
        emit_send_result(&app, result);
    });
}

/// Send a clip directly to an IP:port, bypassing discovery. Fallback for
/// networks where multicast doesn't reach the other device (common on
/// client-isolated/guest Wi-Fi) — the receiver still just needs to be running
/// LocalSend on the default port.
#[tauri::command]
pub fn localsend_send_to_ip(app: AppHandle, id: String, ip: String, port: u16) {
    thread::spawn(move || {
        let result = send_clip_to(&app, &id, &ip, port);
        emit_send_result(&app, result);
    });
}

fn send_clip_to(app: &AppHandle, id: &str, ip: &str, port: u16) -> Result<(), String> {
    let store = app.state::<Store>();
    let entry = store
        .find(id)
        .ok_or_else(|| "That clip is gone.".to_string())?;

    // Figure out what bytes to send: real file(s) on disk, the full-res saved
    // image, or — for plain text — a temp .txt file (deleted after sending).
    let mut temp_to_clean: Option<PathBuf> = None;
    let send_items: Vec<(String, String, PathBuf)> = if let Some(files) = &entry.files {
        files
            .iter()
            .filter_map(|f| {
                let path = PathBuf::from(f);
                let name = path.file_name()?.to_str()?.to_string();
                let mime = guess_mime(&name);
                Some((name, mime, path))
            })
            .collect()
    } else if entry.image_data.is_some() {
        let full = store
            .data_dir
            .join("images")
            .join(format!("{}.png", entry.id));
        if !full.exists() {
            return Err("That image's file is missing.".to_string());
        }
        vec![(format!("{}.png", entry.id), "image/png".to_string(), full)]
    } else {
        let tmp = std::env::temp_dir().join(format!("clip-send-{}.txt", new_id()));
        std::fs::write(&tmp, entry.text.as_bytes()).map_err(|e| e.to_string())?;
        temp_to_clean = Some(tmp.clone());
        vec![("clip.txt".to_string(), "text/plain".to_string(), tmp)]
    };

    let result = send_files(app, ip, port, &send_items);
    if let Some(tmp) = temp_to_clean {
        let _ = std::fs::remove_file(tmp);
    }
    if result.is_ok() {
        record_history(&store, ip, port);
    }
    result
}

/// Remember a device we've successfully sent to, so it's a one-click option
/// next time even if discovery never finds it (common — multicast is finicky
/// on machines with VPNs/VMs/multiple adapters). Best-effort alias lookup via
/// /info so the entry reads as "Clean Papaya" instead of a bare IP.
fn record_history(store: &Store, ip: &str, port: u16) {
    let alias = ls_agent()
        .get(format!("https://{ip}:{port}/api/localsend/v2/info"))
        .call()
        .ok()
        .and_then(|mut r| r.body_mut().read_to_string().ok())
        .and_then(|body| serde_json::from_str::<DeviceInfo>(&body).ok())
        .map(|info| info.alias);

    let mut list: Vec<HistoryEntry> = store
        .get_setting("localsend_history")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    list.retain(|e| e.ip != ip);
    list.insert(
        0,
        HistoryEntry {
            ip: ip.to_string(),
            port,
            alias,
            last_used_ms: now_millis(),
        },
    );
    list.truncate(5);
    if let Ok(json) = serde_json::to_string(&list) {
        store.set_setting("localsend_history", &json);
    }
}

#[tauri::command]
pub fn localsend_get_history(app: AppHandle) -> Vec<HistoryEntry> {
    app.state::<Store>()
        .get_setting("localsend_history")
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn send_files(
    app: &AppHandle,
    ip: &str,
    port: u16,
    items: &[(String, String, PathBuf)],
) -> Result<(), String> {
    let our_info = app.state::<LocalSendState>().device_info();
    let base = format!("https://{ip}:{port}");

    let mut files_req = HashMap::new();
    let mut file_ids: Vec<(String, PathBuf)> = Vec::new();
    for (name, mime, path) in items {
        let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let file_id = new_id();
        files_req.insert(
            file_id.clone(),
            FileMeta {
                id: file_id.clone(),
                file_name: name.clone(),
                size,
                file_type: Some(mime.clone()),
            },
        );
        file_ids.push((file_id, path.clone()));
    }

    let prep_req = PrepareUploadMsg {
        info: our_info,
        files: files_req,
    };
    let body = serde_json::to_vec(&prep_req).map_err(|e| e.to_string())?;

    let mut resp = ls_agent()
        .post(format!("{base}/api/localsend/v2/prepare-upload"))
        .header("Content-Type", "application/json")
        .send(&body[..])
        .map_err(|e| match e {
            ureq::Error::StatusCode(403) => "The other device declined.".to_string(),
            _ => format!("Couldn't reach that device ({e})."),
        })?;
    let text = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let prep: PrepareUploadResp = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let mut sent_any = false;
    for (file_id, path) in &file_ids {
        let Some(token) = prep.files.get(file_id) else {
            continue;
        };
        let url = format!(
            "{base}/api/localsend/v2/upload?sessionId={}&fileId={}&token={}",
            prep.session_id, file_id, token
        );
        let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        ls_agent()
            .post(&url)
            .header("Content-Type", "application/octet-stream")
            .send(file)
            .map_err(|e| format!("Upload failed ({e})."))?;
        sent_any = true;
    }

    if sent_any {
        Ok(())
    } else {
        Err("The other device declined.".to_string())
    }
}

// ── Discovery (UDP multicast) ────────────────────────────────────────────────

fn send_announce(socket: &UdpSocket, app: &AppHandle) {
    let info = app.state::<LocalSendState>().device_info();
    let msg = AnnounceMsg {
        info,
        announce: true,
    };
    if let Ok(bytes) = serde_json::to_vec(&msg) {
        let _ = socket.send_to(&bytes, (MULTICAST_ADDR, LOCALSEND_PORT));
    }
}

fn upsert_peer(app: &AppHandle, info: &DeviceInfo, ip: String) {
    let state = app.state::<LocalSendState>();
    if info.fingerprint == state.fingerprint {
        return; // our own announce (multicast loopback) — ignore
    }
    let peer = PeerInfo {
        fingerprint: info.fingerprint.clone(),
        alias: info.alias.clone(),
        ip,
        port: info.port.unwrap_or(LOCALSEND_PORT),
        device_type: info.device_type.clone(),
        last_seen_ms: now_millis(),
    };
    state
        .peers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(peer.fingerprint.clone(), peer);
}

/// Reply to a multicast announce with our own info via unicast HTTPS register,
/// so the peer learns about us too (LocalSend's discovery is a two-step
/// handshake: multicast announce, then a direct register-back).
fn reply_register(app: &AppHandle, ip: String, port: u16) {
    let app = app.clone();
    thread::spawn(move || {
        let info = app.state::<LocalSendState>().device_info();
        let Ok(body) = serde_json::to_vec(&info) else {
            return;
        };
        let url = format!("https://{ip}:{port}/api/localsend/v2/register");
        let _ = ls_agent()
            .post(&url)
            .header("Content-Type", "application/json")
            .send(&body[..]);
    });
}

/// The LAN-facing IPv4 address, resolved via the OS's own routing table rather
/// than guessed. `join_multicast_v4`/`IP_MULTICAST_IF` need a *specific*
/// interface address — passing `Ipv4Addr::UNSPECIFIED` ("any interface") is
/// ambiguous the moment more than one adapter is up (VPN, Hyper-V, WSL,
/// VMware, VirtualBox, …, all extremely common on a dev machine), and Windows
/// can and does pick a virtual/isolated adapter over the real one, silently
/// breaking discovery in both directions with no error anywhere.
///
/// UDP `connect()` never sends a packet — it just asks the kernel to resolve
/// which local address it *would* use to reach the given destination, which
/// reliably reflects the default-route interface regardless of whether that
/// destination is actually reachable.
fn local_lan_ip() -> Option<Ipv4Addr> {
    let probe = UdpSocket::bind("0.0.0.0:0").ok()?;
    probe.connect("8.8.8.8:80").ok()?;
    match probe.local_addr().ok()?.ip() {
        std::net::IpAddr::V4(v4) => Some(v4),
        std::net::IpAddr::V6(_) => None,
    }
}

/// Force outgoing multicast packets out the given interface. Without this,
/// `send_to(&MULTICAST_ADDR, ..)` is subject to the same multi-adapter
/// ambiguity as the receive side — `std::net` has no safe API for
/// `IP_MULTICAST_IF`, so this goes directly through Winsock on the socket's
/// raw handle (the `windows` crate is already a dependency).
#[cfg(target_os = "windows")]
fn set_multicast_outbound_interface(socket: &UdpSocket, iface: Ipv4Addr) {
    use std::os::windows::io::AsRawSocket;
    use windows::Win32::Networking::WinSock::{setsockopt, IPPROTO_IP, IP_MULTICAST_IF, SOCKET};
    let raw = SOCKET(socket.as_raw_socket() as usize);
    let addr_be = iface.octets(); // already network byte order
    unsafe {
        setsockopt(raw, IPPROTO_IP.0, IP_MULTICAST_IF, Some(&addr_be));
    }
}

#[cfg(not(target_os = "windows"))]
fn set_multicast_outbound_interface(_socket: &UdpSocket, _iface: Ipv4Addr) {}

/// Outer supervisor: only binds the multicast socket while the "LocalSend"
/// tray toggle is on, and drops it (freeing the port, no idle background
/// traffic) the moment it's switched off — a flag alone wouldn't do that,
/// since the socket would stay open and `recv_from` would keep waking up.
/// Off by default; the idle poll here is a cheap 500ms sleep either way.
fn run_discovery(app: AppHandle) {
    let mut retry = RetryBackoff::new();
    loop {
        if !app
            .state::<LocalSendState>()
            .enabled
            .load(Ordering::Relaxed)
        {
            retry.reset();
            thread::sleep(Duration::from_millis(500));
            continue;
        }

        let socket = match UdpSocket::bind(("0.0.0.0", LOCALSEND_PORT)) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("LocalSend: couldn't bind UDP {LOCALSEND_PORT} ({e}), retrying…");
                retry.sleep();
                continue;
            }
        };

        let iface = local_lan_ip().unwrap_or(Ipv4Addr::UNSPECIFIED);
        if let Err(e) = socket.join_multicast_v4(&MULTICAST_ADDR, &iface) {
            eprintln!("LocalSend: couldn't join multicast group on {iface} ({e}), retrying…");
            retry.sleep();
            continue;
        }
        set_multicast_outbound_interface(&socket, iface);
        let _ = socket.set_multicast_loop_v4(false);
        let _ = socket.set_read_timeout(Some(Duration::from_millis(800)));
        eprintln!("LocalSend: discovery active on {iface}");
        retry.reset();

        let mut last_announce = Instant::now() - ANNOUNCE_INTERVAL;
        let mut buf = [0u8; 8192];
        while app
            .state::<LocalSendState>()
            .enabled
            .load(Ordering::Relaxed)
        {
            if last_announce.elapsed() >= ANNOUNCE_INTERVAL {
                send_announce(&socket, &app);
                last_announce = Instant::now();
            }

            match socket.recv_from(&mut buf) {
                Ok((n, src)) => {
                    if let Ok(msg) = serde_json::from_slice::<AnnounceMsg>(&buf[..n]) {
                        let SocketAddr::V4(src4) = src else { continue };
                        let ip = src4.ip().to_string();
                        let port = msg.info.port.unwrap_or(LOCALSEND_PORT);
                        upsert_peer(&app, &msg.info, ip.clone());
                        reply_register(&app, ip, port);
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => {}
            }
        }
        // Loop back around; `socket` drops here (leaves the multicast group,
        // closes the port) since the toggle was switched off.
    }
}

// ── HTTP server (receiving) ──────────────────────────────────────────────────

fn respond_json<T: Serialize>(request: tiny_http::Request, status: u16, body: &T) {
    let json = serde_json::to_string(body).unwrap_or_default();
    let response = Response::from_string(json)
        .with_status_code(status)
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
    let _ = request.respond(response);
}

fn handle_info(app: &AppHandle, request: tiny_http::Request) {
    let info = app.state::<LocalSendState>().device_info();
    respond_json(request, 200, &info);
}

fn handle_register(app: &AppHandle, mut request: tiny_http::Request) {
    let ip = request.remote_addr().map(|a| a.ip().to_string());
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        let _ = request.respond(Response::empty(400));
        return;
    }
    if let (Ok(info), Some(ip)) = (serde_json::from_str::<DeviceInfo>(&body), ip) {
        upsert_peer(app, &info, ip);
    }
    let our_info = app.state::<LocalSendState>().device_info();
    respond_json(request, 200, &our_info);
}

fn handle_prepare_upload(app: &AppHandle, mut request: tiny_http::Request) {
    if !app
        .state::<LocalSendState>()
        .enabled
        .load(Ordering::Relaxed)
    {
        let _ = request.respond(Response::empty(403));
        return;
    }

    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        let _ = request.respond(Response::empty(400));
        return;
    }
    let req: PrepareUploadMsg = match serde_json::from_str(&body) {
        Ok(r) => r,
        Err(_) => {
            let _ = request.respond(Response::empty(400));
            return;
        }
    };

    let store = app.state::<Store>();
    let dir = store.data_dir.join("downloads");
    if std::fs::create_dir_all(&dir).is_err() {
        let _ = request.respond(Response::empty(500));
        return;
    }

    let session_id = new_id();
    let mut files_tokens = HashMap::new();
    let mut pending = HashMap::new();
    for (file_id, meta) in req.files {
        let token = gen_random_hex32();
        let clip_id = new_id();
        let ext = Path::new(&meta.file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let dest = dir.join(format!("{clip_id}.{ext}"));
        pending.insert(
            file_id.clone(),
            PendingFile {
                token: token.clone(),
                clip_id,
                file_name: meta.file_name.clone(),
                file_type: meta.file_type.clone().unwrap_or_default(),
                dest,
            },
        );
        files_tokens.insert(file_id, token);
    }

    app.state::<LocalSendState>()
        .sessions
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(session_id.clone(), UploadSession { files: pending });

    respond_json(
        request,
        200,
        &PrepareUploadResp {
            session_id,
            files: files_tokens,
        },
    );
}

fn handle_upload(app: &AppHandle, mut request: tiny_http::Request, query: &str) {
    let params = parse_query(query);
    let (Some(session_id), Some(file_id), Some(token)) = (
        params.get("sessionId"),
        params.get("fileId"),
        params.get("token"),
    ) else {
        let _ = request.respond(Response::empty(400));
        return;
    };

    let state = app.state::<LocalSendState>();
    let file_info = {
        let sessions = state.sessions.lock().unwrap_or_else(|e| e.into_inner());
        sessions
            .get(session_id)
            .and_then(|s| s.files.get(file_id))
            .filter(|f| &f.token == token)
            .map(|f| {
                (
                    f.dest.clone(),
                    f.clip_id.clone(),
                    f.file_name.clone(),
                    f.file_type.clone(),
                )
            })
    };
    drop(state);

    let Some((dest, clip_id, file_name, file_type)) = file_info else {
        let _ = request.respond(Response::empty(403));
        return;
    };

    let write_result = std::fs::File::create(&dest)
        .and_then(|mut out| std::io::copy(request.as_reader(), &mut out));
    if write_result.is_err() {
        let _ = std::fs::remove_file(&dest);
        let _ = request.respond(Response::empty(500));
        return;
    }

    finalize_received_file(app, &clip_id, &dest, &file_name, &file_type);
    let _ = request.respond(Response::empty(200));
}

fn handle_cancel(app: &AppHandle, request: tiny_http::Request, query: &str) {
    let params = parse_query(query);
    if let Some(session_id) = params.get("sessionId") {
        let state = app.state::<LocalSendState>();
        let removed = state
            .sessions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(session_id);
        if let Some(session) = removed {
            for f in session.files.values() {
                let _ = std::fs::remove_file(&f.dest);
            }
        }
    }
    let _ = request.respond(Response::empty(200));
}

/// Turn a just-received file into a clip, exactly like any other clip —
/// reusing the same `clipboard-new` event the frontend already listens to.
/// Small `text/*` sends are converted back into a plain-text clip (so a
/// "send text" from a phone pastes like normal copy/paste, not a file).
fn finalize_received_file(
    app: &AppHandle,
    clip_id: &str,
    path: &Path,
    file_name: &str,
    file_type: &str,
) {
    let store = app.state::<Store>();
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    if file_type.starts_with("text/") && size > 0 && size <= TEXT_INLINE_MAX {
        if let Ok(text) = std::fs::read_to_string(path) {
            let _ = std::fs::remove_file(path);
            let stored = cap_text(&text);
            let entry = ClipboardEntry {
                id: clip_id.to_string(),
                text: stored,
                process: "LocalSend".to_string(),
                process_icon: None,
                timestamp: now_millis(),
                char_count: text.chars().count(),
                image_data: None,
                pinned: false,
                img_w: 0,
                img_h: 0,
                name: None,
                files: None,
            };
            store.add_clip(&entry);
            let _ = app.emit("clipboard-new", entry);
            return;
        }
    }

    let mut image_data = None;
    let mut img_w = 0u32;
    let mut img_h = 0u32;
    if is_image_path(path) {
        if let Some((thumb, w, h)) = thumbnail_image_file(path) {
            image_data = Some(thumb);
            img_w = w;
            img_h = h;
        }
    }

    let entry = ClipboardEntry {
        id: clip_id.to_string(),
        text: file_name.to_string(),
        process: "LocalSend".to_string(),
        process_icon: None,
        timestamp: now_millis(),
        char_count: size as usize,
        image_data,
        pinned: false,
        img_w,
        img_h,
        name: Some(file_name.to_string()),
        files: Some(vec![path.to_string_lossy().to_string()]),
    };
    store.add_clip(&entry);
    let _ = app.emit("clipboard-new", entry);
}

fn handle_request(app: &AppHandle, request: tiny_http::Request) {
    let full_url = request.url().to_string();
    let (path, query) = match full_url.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (full_url, String::new()),
    };
    let method = request.method().as_str().to_string();

    match (method.as_str(), path.as_str()) {
        ("GET", "/api/localsend/v2/info") => handle_info(app, request),
        ("POST", "/api/localsend/v2/register") => handle_register(app, request),
        ("POST", "/api/localsend/v2/prepare-upload") => handle_prepare_upload(app, request),
        ("POST", "/api/localsend/v2/upload") => handle_upload(app, request, &query),
        ("POST", "/api/localsend/v2/cancel") => handle_cancel(app, request, &query),
        _ => {
            let _ = request.respond(Response::empty(404));
        }
    }
}

/// Same on/off-releases-the-socket shape as `run_discovery` above, using
/// `recv_timeout` instead of the blocking `recv()` so the loop actually gets
/// a chance to notice the toggle flipped off (a plain `recv()` would sit
/// blocked until the next request ever arrived, never releasing the port).
fn run_http_server(app: AppHandle, certificate: Vec<u8>, private_key: Vec<u8>) {
    let mut retry = RetryBackoff::new();
    loop {
        if !app
            .state::<LocalSendState>()
            .enabled
            .load(Ordering::Relaxed)
        {
            retry.reset();
            thread::sleep(Duration::from_millis(500));
            continue;
        }

        let ssl = SslConfig {
            certificate: certificate.clone(),
            private_key: private_key.clone(),
        };
        let server = match tiny_http::Server::https(("0.0.0.0", LOCALSEND_PORT), ssl) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("LocalSend: couldn't bind HTTPS {LOCALSEND_PORT} ({e}), retrying…");
                retry.sleep();
                continue;
            }
        };
        eprintln!("LocalSend: HTTPS server listening on {LOCALSEND_PORT}");
        retry.reset();

        while app
            .state::<LocalSendState>()
            .enabled
            .load(Ordering::Relaxed)
        {
            match server.recv_timeout(Duration::from_millis(800)) {
                Ok(Some(request)) => {
                    let app = app.clone();
                    thread::spawn(move || handle_request(&app, request));
                }
                Ok(None) => {} // timed out — loop back and recheck the toggle
                Err(_) => break,
            }
        }
        // `server` drops here when disabled (or on a socket error), closing
        // the listening port until the toggle turns it back on.
    }
}

/// Start the discovery (UDP) and HTTPS server threads. Both stay alive for the
/// app's lifetime; the "LocalSend" tray toggle gates behavior at runtime
/// (via `LocalSendState::enabled`) rather than stopping/restarting threads.
pub fn start(app: AppHandle) {
    let (cert, key) = load_or_create_tls(&app.state::<Store>());
    let a1 = app.clone();
    thread::spawn(move || run_discovery(a1));
    thread::spawn(move || run_http_server(app, cert, key));
}

// ── Firewall exception (receiving needs one; sending doesn't) ───────────────
//
// Windows Firewall blocks unsolicited inbound connections to unrecognized
// programs by default — especially on a "Public" network profile, which is
// common even on a home LAN unless the user has manually set it to Private.
// Sending is unaffected (outbound isn't filtered the same way), but receiving
// silently hangs with no error on either end: the sender just sees "waiting"
// forever, because the connection never reaches our HTTPS server at all.
//
// Adding the exception needs admin rights, so it can't happen silently during
// a per-user, unelevated install — this requests it (one UAC prompt) the first
// time LocalSend is actually turned on, with a message box explaining why the
// prompt is about to appear, matching the Win+V override's pattern.

/// Run once per install (tracked via a Store setting) — call whenever
/// LocalSend is enabled, whether by a fresh toggle click or because it was
/// already on from a previous session at startup.
pub fn ensure_firewall_rule(store: &Store) {
    if store.get_setting("localsend_firewall_ok").as_deref() == Some("1") {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        crate::message_box(
            "Clip — allow LocalSend through the firewall",
            "Windows will ask for permission to let LocalSend receive files \
             from other devices on your network.\n\n\
             Approve the prompt that appears next. If you skip it, sending \
             clips to other devices still works — only receiving from them \
             won't.",
        );
        let ok = add_firewall_rule();
        store.set_setting("localsend_firewall_ok", if ok { "1" } else { "0" });
    }
}

#[cfg(target_os = "windows")]
fn add_firewall_rule() -> bool {
    use windows::core::{w, PCWSTR};
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let exe = exe.to_string_lossy();

    // One elevated cmd.exe call adding both rules, so there's a single UAC
    // prompt instead of two. `&` chains regardless of the first command's
    // exit code, so a duplicate-name failure on a reinstall doesn't stop the
    // second rule from being added.
    let params = format!(
        "/c netsh advfirewall firewall add rule name=\"Clip - LocalSend (TCP)\" dir=in action=allow program=\"{exe}\" protocol=TCP localport=53317 enable=yes & \
         netsh advfirewall firewall add rule name=\"Clip - LocalSend (UDP)\" dir=in action=allow program=\"{exe}\" protocol=UDP localport=53317 enable=yes"
    );
    let params_w: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();

    unsafe {
        // ShellExecuteW's "runas" verb triggers the UAC consent prompt. Return
        // value is a legacy HINSTANCE-shaped status: >32 means the elevated
        // process actually launched (the user approved UAC); <=32 covers
        // every failure/cancellation case.
        let result = ShellExecuteW(
            None,
            w!("runas"),
            w!("cmd.exe"),
            PCWSTR(params_w.as_ptr()),
            None,
            SW_HIDE,
        );
        (result.0 as isize) > 32
    }
}
