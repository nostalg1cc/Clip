use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use window_vibrancy::{clear_acrylic, clear_mica};

#[cfg(target_os = "windows")]
use std::ffi::c_void;

mod store;
use store::{ClipboardEntry, Store};

mod downloader;

const BAR_HEIGHT_LOGICAL: f64 = 400.0;
const MAX_TEXT_LEN: usize = 100_000;
const IMG_MAX_DIM: u32 = 900;

pub(crate) fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn new_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_nanos();
    format!("{}-{}", now_millis(), nanos)
}

/// UTF-8 safe truncation to a maximum number of *characters*.
fn cap_text(s: &str) -> String {
    if s.chars().count() > MAX_TEXT_LEN {
        s.chars().take(MAX_TEXT_LEN).collect()
    } else {
        s.to_string()
    }
}

// ── PasteGuard — stops the watcher from re-capturing clips we paste ────────────

struct PasteGuard {
    text: Mutex<Option<String>>,
    skip_image: Mutex<bool>,
    skip_files: Mutex<bool>,
}

impl PasteGuard {
    fn new() -> Self {
        Self { text: Mutex::new(None), skip_image: Mutex::new(false), skip_files: Mutex::new(false) }
    }
}

// ── Theme (light/dark acrylic) ────────────────────────────────────────────────

struct ThemeState(Mutex<bool>); // true = light
struct BackdropState(Mutex<bool>); // true = acrylic, false = mica

/// HWND (as isize) of the window that was focused right before we showed the
/// bar. We restore focus to it before pasting so the keystroke lands in the
/// user's real target, not wherever Windows happens to move focus on hide.
struct PrevForeground(Mutex<isize>);

/// Read the Windows "apps use light theme" preference (default: dark).
#[cfg(target_os = "windows")]
fn windows_is_light() -> bool {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::core::w;
    unsafe {
        let mut data: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let res = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut data as *mut u32 as *mut _),
            Some(&mut size),
        );
        res.0 == 0 && data != 0
    }
}

#[cfg(not(target_os = "windows"))]
fn windows_is_light() -> bool { false }

struct WinVOverrideState(Mutex<bool>);

#[cfg(target_os = "windows")]
fn get_registry_disabled_hotkeys() -> Option<String> {
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    use windows::core::w;
    unsafe {
        let mut size: u32 = 0;
        let res = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced"),
            w!("DisabledHotkeys"),
            RRF_RT_REG_SZ,
            None,
            None,
            Some(&mut size),
        );
        if res.0 != 0 || size == 0 {
            return None;
        }
        
        let mut buf = vec![0u16; (size as usize / 2) + 1];
        let res = RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced"),
            w!("DisabledHotkeys"),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr() as *mut _),
            Some(&mut size),
        );
        if res.0 == 0 {
            let len = buf.iter().position(|&x| x == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..len]))
        } else {
            None
        }
    }
}

#[cfg(target_os = "windows")]
fn set_registry_disabled_hotkeys(val: &str) -> bool {
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    use windows::core::w;
    let subkey = w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced");
    let value_name = w!("DisabledHotkeys");
    let wide_val: Vec<u16> = val.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let res = RegSetKeyValueW(
            HKEY_CURRENT_USER,
            subkey,
            value_name,
            REG_SZ.0,
            Some(wide_val.as_ptr() as *const _),
            (wide_val.len() * 2) as u32,
        );
        res.0 == 0
    }
}

#[cfg(target_os = "windows")]
fn delete_registry_disabled_hotkeys() -> bool {
    use windows::Win32::System::Registry::{
        RegOpenKeyExW, RegDeleteValueW, RegCloseKey, HKEY_CURRENT_USER, KEY_SET_VALUE, HKEY
    };
    use windows::core::w;
    unsafe {
        let mut hkey = HKEY::default();
        let res = RegOpenKeyExW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced"),
            Some(0),
            KEY_SET_VALUE,
            &mut hkey,
        );
        if res.0 == 0 {
            let del_res = RegDeleteValueW(hkey, w!("DisabledHotkeys"));
            let _ = RegCloseKey(hkey);
            del_res.0 == 0
        } else {
            false
        }
    }
}

/// Write a REG_SZ value under HKCU\Software\Clip (our own backup area).
#[cfg(target_os = "windows")]
fn write_clip_reg(name: &str, val: &str) {
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    use windows::core::{w, PCWSTR};
    let name_w = encode_wide(name);
    let val_w = encode_wide(val);
    unsafe {
        let _ = RegSetKeyValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Clip"),
            PCWSTR(name_w.as_ptr()),
            REG_SZ.0,
            Some(val_w.as_ptr() as *const _),
            (val_w.len() * 2) as u32,
        );
    }
}

/// Keep trying to grab Win+V in the background.
///
/// Explorer only stops owning Win+V after it restarts (or the user signs back
/// in), so an immediate `register` right after we edit the registry usually
/// fails. This retries so the hotkey is claimed the moment Explorer lets go —
/// no app relaunch required.
#[cfg(target_os = "windows")]
fn register_win_v_with_retry(app: &tauri::AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        for attempt in 0..180u32 {
            let probe = Shortcut::new(Some(Modifiers::SUPER), Code::KeyV);
            if app.global_shortcut().is_registered(probe) {
                return;
            }
            let sc = Shortcut::new(Some(Modifiers::SUPER), Code::KeyV);
            if app.global_shortcut().register(sc).is_ok() {
                return;
            }
            thread::sleep(Duration::from_secs(if attempt < 20 { 1 } else { 5 }));
        }
    });
}

/// Show a native, always-visible message box on its own thread (non-blocking).
#[cfg(target_os = "windows")]
fn message_box(title: &str, text: &str) {
    let title = title.to_string();
    let text = text.to_string();
    thread::spawn(move || {
        use windows::Win32::UI::WindowsAndMessaging::{
            MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST,
        };
        use windows::core::PCWSTR;
        let text_w = encode_wide(&text);
        let title_w = encode_wide(&title);
        unsafe {
            let _ = MessageBoxW(
                None,
                PCWSTR(text_w.as_ptr()),
                PCWSTR(title_w.as_ptr()),
                MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND,
            );
        }
    });
}

#[cfg(target_os = "windows")]
fn update_win_v_override(app: &tauri::AppHandle, enabled: bool) {
    let win_v = Shortcut::new(Some(Modifiers::SUPER), Code::KeyV);

    if enabled {
        // Free Win+V from Explorer by adding "V" to DisabledHotkeys, backing up
        // the original so we can restore it on disable/uninstall.
        match get_registry_disabled_hotkeys() {
            Some(curr) if curr.contains('V') || curr.contains('v') => {
                // Explorer already ignores Win+V — record the value verbatim so
                // we never strip a "V" the user put there themselves.
                app.state::<Store>().set_setting("disabled_hotkeys_backup", &curr);
                write_clip_reg("DisabledHotkeysBackup", &curr);
            }
            Some(curr) => {
                app.state::<Store>().set_setting("disabled_hotkeys_backup", &curr);
                write_clip_reg("DisabledHotkeysBackup", &curr);
                let _ = set_registry_disabled_hotkeys(&format!("{curr}V"));
            }
            None => {
                app.state::<Store>().set_setting("disabled_hotkeys_backup", "");
                write_clip_reg("DisabledHotkeysBackup", "__NONE__");
                let _ = set_registry_disabled_hotkeys("V");
            }
        }
        write_clip_reg("WinVOverride", "1");

        // Try immediately (works once Explorer has released it); otherwise keep
        // retrying in the background. Shift+Alt+V stays registered throughout, so
        // the app is always reachable even before Explorer restarts.
        if app.global_shortcut().register(win_v).is_err() {
            register_win_v_with_retry(app);
        }

        message_box(
            "Clip — Win+V enabled",
            "Win+V will open Clip after Windows Explorer restarts.\n\n\
             To apply it now: open Task Manager, right-click \"Windows Explorer\" \
             and choose Restart — or simply sign out and back in.\n\n\
             Until then, Shift+Alt+V still opens Clip.",
        );
    } else {
        // Restore the original DisabledHotkeys from our backup.
        match app.state::<Store>().get_setting("disabled_hotkeys_backup").as_deref() {
            // A real original value was saved — put it back exactly.
            Some(val) if !val.is_empty() && val != "__NONE__" => {
                let _ = set_registry_disabled_hotkeys(val);
            }
            // Originally empty / absent ("" or "__NONE__") — remove the value.
            Some(_) => {
                let _ = delete_registry_disabled_hotkeys();
            }
            // No backup recorded (shouldn't happen) — best effort: strip our V.
            None => {
                if let Some(curr) = get_registry_disabled_hotkeys() {
                    let stripped: String = curr.chars().filter(|&c| c != 'V').collect();
                    if stripped.is_empty() {
                        let _ = delete_registry_disabled_hotkeys();
                    } else {
                        let _ = set_registry_disabled_hotkeys(&stripped);
                    }
                }
            }
        }
        write_clip_reg("WinVOverride", "0");
        let _ = app.global_shortcut().unregister(win_v);

        message_box(
            "Clip — Win+V restored",
            "Win+V has been returned to Windows.\n\n\
             Restart Windows Explorer (Task Manager \u{2192} Restart) or sign out \
             and back in to get the Windows clipboard history back.\n\n\
             Clip still opens with Shift+Alt+V.",
        );
    }
}

fn encode_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(not(target_os = "windows"))]
fn update_win_v_override(_app: &tauri::AppHandle, _enabled: bool) {}


/// Accent state + tint (r,g,b,a) for the current theme/material.
///
/// state: 3 = blur-behind ("mica"-like), 4 = acrylic-blur-behind. Dark mode is
/// intentionally a touch darker than a plain grey.
fn accent_for(light: bool, acrylic: bool) -> (u32, (u8, u8, u8, u8)) {
    let state = if acrylic { 4 } else { 3 };
    let tint = if light {
        (244, 245, 248, 180)
    } else {
        (20, 20, 25, 180)
    };
    (state, tint)
}

/// Apply a legacy DWM accent (translucent blur / acrylic) via the undocumented
/// `SetWindowCompositionAttribute`.
///
/// Why not the Win11 system backdrop (`DWMWA_SYSTEMBACKDROP_TYPE`)? That backdrop
/// renders in a dimmed, near-opaque "inactive" state whenever the window isn't
/// the foreground window — and our bar is *deliberately* never activated. The
/// legacy accent stays fully translucent regardless of focus AND honours the
/// tint colour, so we also control how dark it looks.
#[cfg(target_os = "windows")]
fn apply_accent(window: &tauri::WebviewWindow, state: u32, tint: (u8, u8, u8, u8)) {
    use windows::core::{s, w, BOOL};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress};

    #[repr(C)]
    struct AccentPolicy {
        accent_state: u32,
        accent_flags: u32,
        gradient_color: u32,
        animation_id: u32,
    }
    #[repr(C)]
    struct WinCompAttrData {
        attrib: u32,
        pv_data: *mut c_void,
        cb_data: usize,
    }

    let hwnd = match window.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    unsafe {
        let user32 = match GetModuleHandleW(w!("user32.dll")) {
            Ok(h) => h,
            Err(_) => return,
        };
        let proc = match GetProcAddress(user32, s!("SetWindowCompositionAttribute")) {
            Some(p) => p,
            None => return,
        };
        type SetWca = unsafe extern "system" fn(HWND, *mut WinCompAttrData) -> BOOL;
        let set_wca: SetWca = std::mem::transmute(proc);

        let (r, g, b, mut a) = tint;
        let is_acrylic = state == 4;
        if is_acrylic && a == 0 {
            a = 1; // acrylic dislikes a fully-zero alpha
        }
        let gradient =
            (r as u32) | ((g as u32) << 8) | ((b as u32) << 16) | ((a as u32) << 24);
        let mut policy = AccentPolicy {
            accent_state: state,
            accent_flags: if is_acrylic { 0 } else { 2 },
            gradient_color: gradient,
            animation_id: 0,
        };
        let mut data = WinCompAttrData {
            attrib: 0x13, // WCA_ACCENT_POLICY
            pv_data: &mut policy as *mut _ as *mut c_void,
            cb_data: std::mem::size_of::<AccentPolicy>(),
        };
        let _ = set_wca(hwnd, &mut data);
    }
}

#[cfg(not(target_os = "windows"))]
fn apply_accent(_window: &tauri::WebviewWindow, _state: u32, _tint: (u8, u8, u8, u8)) {}

/// Apply the chosen backdrop (acrylic or mica) in the chosen theme (light/dark)
/// and notify the webview so it can swap its CSS palette.
fn apply_backdrop(window: &tauri::WebviewWindow, light: bool, acrylic: bool) {
    // Make sure the Win11 system backdrop is OFF — on our always-inactive window
    // it renders near-opaque. The legacy accent below stays translucent.
    let _ = clear_acrylic(window);
    let _ = clear_mica(window);

    let (state, tint) = accent_for(light, acrylic);
    apply_accent(window, state, tint);

    let _ = window.emit("theme-changed", if light { "light" } else { "dark" });
}

fn apply_theme(window: &tauri::WebviewWindow, light: bool) {
    let acrylic = {
        let bs = window.state::<BackdropState>();
        let val = *bs.0.lock().unwrap_or_else(|e| e.into_inner());
        val
    };
    apply_backdrop(window, light, acrylic);
}

/// Re-assert the accent while the window is visible (cheap, idempotent). Kept as
/// a belt-and-suspenders call after each show.
fn reassert_backdrop(window: &tauri::WebviewWindow) {
    let light = *window.state::<ThemeState>().0.lock().unwrap_or_else(|e| e.into_inner());
    let acrylic = *window.state::<BackdropState>().0.lock().unwrap_or_else(|e| e.into_inner());
    let (state, tint) = accent_for(light, acrylic);
    apply_accent(window, state, tint);
}


#[tauri::command]
fn get_theme(theme: tauri::State<'_, ThemeState>) -> String {
    let light = *theme.0.lock().unwrap_or_else(|e| e.into_inner());
    if light { "light".into() } else { "dark".into() }
}

/// Let the bar take focus so the user can type in the search box. Called from
/// the front-end on search-box click; clears WS_EX_NOACTIVATE first so the
/// otherwise non-activating window can actually come to the foreground.
#[tauri::command]
fn focus_search(window: tauri::WebviewWindow) {
    #[cfg(target_os = "windows")]
    set_no_activate(&window, false);
    let _ = window.set_focus();
}

/// Hide the bar from the front-end (Esc, open-external). Routed through the
/// backend so it uses the same raw ShowWindow path as every other hide.
#[tauri::command]
fn hide_window(window: tauri::WebviewWindow) {
    hide_bar(&window);
}

fn is_image_path(p: &std::path::Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref(),
        Some("png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "ico" | "tiff")
    )
}

// ── Windows: copied files (CF_HDROP) ─────────────────────────────────────────

#[cfg(target_os = "windows")]
const CF_HDROP: u32 = 15;

#[cfg(target_os = "windows")]
fn get_clipboard_files() -> Vec<String> {
    use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};
    let mut files = Vec::new();
    unsafe {
        if OpenClipboard(None).is_err() { return files; }
        if let Ok(handle) = GetClipboardData(CF_HDROP) {
            if !handle.is_invalid() {
                let hdrop = HDROP(handle.0);
                let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
                for i in 0..count {
                    let len = DragQueryFileW(hdrop, i, None) as usize;
                    if len == 0 { continue; }
                    let mut buf = vec![0u16; len + 1];
                    let got = DragQueryFileW(hdrop, i, Some(&mut buf));
                    if got > 0 { files.push(String::from_utf16_lossy(&buf[..got as usize])); }
                }
            }
        }
        let _ = CloseClipboard();
    }
    files
}

#[cfg(not(target_os = "windows"))]
fn get_clipboard_files() -> Vec<String> { Vec::new() }

#[cfg(target_os = "windows")]
fn set_clipboard_files(files: &[String]) -> Option<()> {
    use windows::core::BOOL;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::UI::Shell::DROPFILES;

    // Double-null-terminated wide path list
    let mut wide: Vec<u16> = Vec::new();
    for f in files {
        wide.extend(f.encode_utf16());
        wide.push(0);
    }
    wide.push(0);

    let header = std::mem::size_of::<DROPFILES>();
    let total = header + wide.len() * 2;

    unsafe {
        let hglobal = GlobalAlloc(GMEM_MOVEABLE, total).ok()?;
        let ptr = GlobalLock(hglobal);
        if ptr.is_null() { return None; }

        let df = ptr as *mut DROPFILES;
        (*df).pFiles = header as u32;
        (*df).fWide = BOOL(1);

        let dst = (ptr as *mut u8).add(header) as *mut u16;
        std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
        let _ = GlobalUnlock(hglobal);

        if OpenClipboard(None).is_err() { return None; }
        let _ = EmptyClipboard();
        if SetClipboardData(CF_HDROP, Some(HANDLE(hglobal.0))).is_err() {
            let _ = CloseClipboard();
            return None;
        }
        let _ = CloseClipboard();
    }
    Some(())
}

#[cfg(not(target_os = "windows"))]
fn set_clipboard_files(_files: &[String]) -> Option<()> { None }

// ── Windows: clipboard sequence number ───────────────────────────────────────

#[cfg(target_os = "windows")]
fn clipboard_seq() -> u32 {
    unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

// ── Windows: foreground process info ─────────────────────────────────────────

fn get_foreground_process_info() -> (String, String) {
    #[cfg(target_os = "windows")]
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };
        use windows::core::PWSTR;

        let hwnd = GetForegroundWindow();
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));

        if let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            let mut buf = vec![0u16; 260];
            let mut size = 260u32;
            if QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buf.as_mut_ptr()),
                &mut size,
            )
            .is_ok()
            {
                let _ = CloseHandle(handle);
                let exe_path = String::from_utf16_lossy(&buf[..size as usize]).to_string();
                let name = std::path::Path::new(&exe_path)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                return (name, exe_path);
            }
            let _ = CloseHandle(handle);
        }
    }
    ("unknown".to_string(), String::new())
}

// ── Windows: extract process icon as base64 PNG ───────────────────────────────

#[cfg(target_os = "windows")]
fn extract_icon_base64(exe_path: &str) -> Option<String> {
    use windows::Win32::Graphics::Gdi::{
        BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, DeleteDC, DeleteObject,
        DIB_RGB_COLORS, GetDIBits, HGDIOBJ, SelectObject,
    };
    use windows::Win32::UI::Shell::{SHFILEINFOW, SHGetFileInfoW, SHGFI_ICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};
    use windows::core::PCWSTR;

    unsafe {
        let wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sfi = std::mem::zeroed::<SHFILEINFOW>();

        let result = SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            Default::default(),
            Some(&mut sfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON,
        );
        if result == 0 { return None; }

        let hicon = sfi.hIcon;
        let mut icon_info = std::mem::zeroed::<ICONINFO>();
        if GetIconInfo(hicon, &mut icon_info).is_err() {
            let _ = DestroyIcon(hicon);
            return None;
        }

        let hbmp = icon_info.hbmColor;
        if hbmp.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
            let _ = DestroyIcon(hicon);
            return None;
        }

        let size: i32 = 32;
        let hdc = CreateCompatibleDC(None);
        SelectObject(hdc, HGDIOBJ(hbmp.0));

        let mut bmi = std::mem::zeroed::<BITMAPINFO>();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = size;
        bmi.bmiHeader.biHeight = -size;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = 0;

        let mut pixels = vec![0u8; (size * size * 4) as usize];
        GetDIBits(hdc, hbmp, 0, size as u32, Some(pixels.as_mut_ptr() as _), &mut bmi, DIB_RGB_COLORS);

        let _ = DeleteDC(hdc);
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmColor.0));
        let _ = DeleteObject(HGDIOBJ(icon_info.hbmMask.0));
        let _ = DestroyIcon(hicon);

        for chunk in pixels.chunks_mut(4) { chunk.swap(0, 2); } // BGRA → RGBA

        let img = image::DynamicImage::ImageRgba8(
            image::RgbaImage::from_raw(size as u32, size as u32, pixels)?,
        );
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;

        use base64::Engine;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
    }
}

#[cfg(not(target_os = "windows"))]
fn extract_icon_base64(_exe_path: &str) -> Option<String> {
    None
}

// ── Image: arboard frame → base64 PNG thumbnail ──────────────────────────────

/// Save the full-res original to {dir}/images/{id}.png and return a small
/// thumbnail data URL for the card preview.
fn save_image_clip(img: arboard::ImageData, dir: &std::path::Path, id: &str) -> Option<String> {
    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.into_owned())?;
    let dyn_img = image::DynamicImage::ImageRgba8(rgba);
    let images_dir = dir.join("images");
    let _ = std::fs::create_dir_all(&images_dir);
    let _ = dyn_img.save_with_format(images_dir.join(format!("{id}.png")), image::ImageFormat::Png);
    let thumb = dyn_img.thumbnail(IMG_MAX_DIM, IMG_MAX_DIM);
    let mut png = Vec::new();
    thumb.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    use base64::Engine;
    Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)))
}

/// Generate a thumbnail data URL (+ dimensions) for an image file on disk.
fn thumbnail_image_file(path: &std::path::Path) -> Option<(String, u32, u32)> {
    let img = image::open(path).ok()?;
    let (w, h) = (img.width(), img.height());
    let thumb = img.thumbnail(IMG_MAX_DIM, IMG_MAX_DIM);
    let mut png = Vec::new();
    thumb.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).ok()?;
    use base64::Engine;
    Some((
        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(&png)),
        w, h,
    ))
}

/// Put a saved original image file onto the clipboard at full resolution.
fn set_clipboard_image_file(path: &std::path::Path) -> Option<()> {
    let img = image::open(path).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let mut cb = arboard::Clipboard::new().ok()?;
    cb.set_image(arboard::ImageData {
        width: w, height: h, bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    }).ok()?;
    Some(())
}

/// Decode a stored `data:image/png;base64,...` URL and place it on the clipboard.
fn set_clipboard_image(data_url: &str) -> Option<()> {
    use base64::Engine;
    let b64 = data_url.split(',').nth(1)?;
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    let img = image::load_from_memory(&bytes).ok()?;
    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as usize, rgba.height() as usize);
    let mut cb = arboard::Clipboard::new().ok()?;
    cb.set_image(arboard::ImageData {
        width: w,
        height: h,
        bytes: std::borrow::Cow::Owned(rgba.into_raw()),
    })
    .ok()?;
    Some(())
}

// ── Windows: send Ctrl+V ──────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn send_ctrl_v() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS,
        KEYEVENTF_KEYUP, VK_CONTROL, VIRTUAL_KEY,
    };
    let vk_v = VIRTUAL_KEY(0x56);
    unsafe {
        let inputs = [
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_CONTROL, wScan: 0, dwFlags: KEYBD_EVENT_FLAGS(0), time: 0, dwExtraInfo: 0 } } },
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk_v,       wScan: 0, dwFlags: KEYBD_EVENT_FLAGS(0), time: 0, dwExtraInfo: 0 } } },
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk_v,       wScan: 0, dwFlags: KEYEVENTF_KEYUP,     time: 0, dwExtraInfo: 0 } } },
            INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_CONTROL, wScan: 0, dwFlags: KEYEVENTF_KEYUP,     time: 0, dwExtraInfo: 0 } } },
        ];
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

/// Give keyboard focus back to the window that had it before the bar appeared.
#[cfg(target_os = "windows")]
fn restore_foreground(prev: isize) {
    if prev == 0 {
        return;
    }
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{IsWindow, SetForegroundWindow};
    let hwnd = HWND(prev as *mut c_void);
    unsafe {
        if IsWindow(Some(hwnd)).as_bool() {
            let _ = SetForegroundWindow(hwnd);
        }
    }
}

/// Hide the bar, hand focus back to the user's target window, then paste.
///
/// Restoring the exact prior foreground window (rather than relying on whatever
/// Windows focuses after `hide`) keeps the Ctrl+V from occasionally landing in
/// the wrong place.
fn hide_and_paste(window: &tauri::WebviewWindow) {
    // Capture, *before* hiding, whether the bar itself currently holds focus.
    // In the default non-activating flow it never does — the target window kept
    // focus the whole time — so we must NOT touch the foreground on paste.
    // Re-activating the target (SetForegroundWindow) is exactly what dismisses
    // focus-independent popups like 1Password's. We only restore focus in the
    // case where the user clicked into the search box (which took focus).
    #[cfg(target_os = "windows")]
    let (prev, we_had_focus) = {
        use std::sync::atomic::Ordering;
        use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
        let prev = *window
            .state::<PrevForeground>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let fg = unsafe { GetForegroundWindow() };
        let ours = OVERLAY_HWND.load(Ordering::Relaxed);
        (prev, ours != 0 && fg.0 as isize == ours)
    };

    hide_bar(window);

    thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        #[cfg(target_os = "windows")]
        {
            if we_had_focus {
                restore_foreground(prev);
                thread::sleep(Duration::from_millis(40));
            }
            send_ctrl_v();
        }
    });
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_history(state: tauri::State<'_, Store>) -> Vec<ClipboardEntry> {
    state.get_all()
}

#[tauri::command]
fn toggle_pin(state: tauri::State<'_, Store>, id: String) -> bool {
    state.toggle_pin(&id)
}

#[tauri::command]
fn delete_clip(state: tauri::State<'_, Store>, id: String) {
    state.delete_clip(&id);
}

#[tauri::command]
fn clear_history(state: tauri::State<'_, Store>) {
    state.clear_all();
}

#[tauri::command]
fn rename_clip(state: tauri::State<'_, Store>, id: String, name: String) {
    let trimmed = name.trim();
    state.rename(&id, if trimmed.is_empty() { None } else { Some(trimmed.to_string()) });
}

/// Place a clip on the system clipboard, setting the right paste-guard so the
/// watcher ignores the change. Handles files, full-res images, and text.
fn place_on_clipboard(state: &Store, guard: &PasteGuard, entry: &ClipboardEntry) {
    if let Some(files) = &entry.files {
        *guard.skip_files.lock().unwrap_or_else(|e| e.into_inner()) = true;
        let _ = set_clipboard_files(files);
    } else if let Some(data_url) = &entry.image_data {
        *guard.skip_image.lock().unwrap_or_else(|e| e.into_inner()) = true;
        let full = state.data_dir.join("images").join(format!("{}.png", entry.id));
        if full.exists() {
            let _ = set_clipboard_image_file(&full);
        } else {
            let _ = set_clipboard_image(data_url);
        }
    } else {
        *guard.text.lock().unwrap_or_else(|e| e.into_inner()) = Some(entry.text.clone());
        if let Ok(mut cb) = arboard::Clipboard::new() { let _ = cb.set_text(&entry.text); }
    }
}

/// Copy a clip to the clipboard WITHOUT pasting (right-click action).
#[tauri::command]
fn copy_clip(
    state: tauri::State<'_, Store>,
    guard: tauri::State<'_, PasteGuard>,
    id: String,
) {
    if let Some(entry) = state.find(&id) {
        place_on_clipboard(&state, &guard, &entry);
    }
}

/// Copy arbitrary text to the clipboard without pasting (emoji right-click).
#[tauri::command]
fn copy_text(guard: tauri::State<'_, PasteGuard>, text: String) {
    *guard.text.lock().unwrap_or_else(|e| e.into_inner()) = Some(text.clone());
    if let Ok(mut cb) = arboard::Clipboard::new() { let _ = cb.set_text(&text); }
}

/// Open a link in the browser, or a path in the file explorer (Alt-click).
#[tauri::command]
fn open_external(app: tauri::AppHandle, target: String) {
    use tauri_plugin_opener::OpenerExt;
    let t = target.trim().to_string();
    let is_url = t.starts_with("http://") || t.starts_with("https://")
        || t.starts_with("mailto:") || t.starts_with("tel:");
    if is_url {
        let _ = app.opener().open_url(t, None::<&str>);
    } else {
        let _ = app.opener().open_path(t, None::<&str>);
    }
}

/// Paste a clip by id. Handles both text and image clips, then hides the
/// window and simulates Ctrl+V into whatever was focused before us.
#[tauri::command]
fn paste_clip(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Store>,
    guard: tauri::State<'_, PasteGuard>,
    id: String,
) {
    if let Some(entry) = state.find(&id) {
        place_on_clipboard(&state, &guard, &entry);
    }
    hide_and_paste(&window);
}

/// Paste an arbitrary string (used by the emoji picker). Guarded so the watcher
/// does not turn it into a new clip.
#[tauri::command]
fn paste_text(
    window: tauri::WebviewWindow,
    guard: tauri::State<'_, PasteGuard>,
    text: String,
) {
    *guard.text.lock().unwrap_or_else(|e| e.into_inner()) = Some(text.clone());
    if let Ok(mut cb) = arboard::Clipboard::new() {
        let _ = cb.set_text(&text);
    }
    hide_and_paste(&window);
}

// ── Clipboard watcher ─────────────────────────────────────────────────────────

fn start_clipboard_watcher(app: tauri::AppHandle) {
    thread::spawn(move || {
        let mut clipboard = match arboard::Clipboard::new() {
            Ok(c) => c,
            Err(_) => return,
        };

        #[cfg(target_os = "windows")]
        let mut last_seq: u32 = clipboard_seq();
        let mut last_text = String::new();
        let mut last_image = String::new();
        let mut last_files = String::new();
        let mut ticks: u32 = 0;

        loop {
            thread::sleep(Duration::from_millis(200));

            // Every ~30 min, expire stale clips and refresh the UI if anything went
            ticks = ticks.wrapping_add(1);
            if ticks % 9000 == 0 {
                let state = app.state::<Store>();
                if state.prune_expired() {
                    let _ = app.emit("clips-updated", state.get_all());
                }
            }

            #[cfg(target_os = "windows")]
            {
                let seq = clipboard_seq();
                if seq == last_seq { continue; }
                last_seq = seq;
            }

            // ── File branch (copied files from Explorer) ──
            {
                let files = get_clipboard_files();
                if !files.is_empty() {
                    // Was this our own paste? skip it
                    {
                        let g = app.state::<PasteGuard>();
                        let mut skip = g.skip_files.lock().unwrap_or_else(|e| e.into_inner());
                        if *skip { *skip = false; continue; }
                    }
                    let joined = files.join("\n");
                    if joined == last_files { continue; }
                    last_files = joined.clone();

                    let (process, exe_path) = get_foreground_process_info();
                    let process_icon = if exe_path.is_empty() { None } else { extract_icon_base64(&exe_path) };
                    let id = new_id();

                    // Image files get a preview thumbnail
                    let mut image_data = None;
                    let mut img_w = 0u32;
                    let mut img_h = 0u32;
                    if files.len() == 1 {
                        let p = std::path::Path::new(&files[0]);
                        if is_image_path(p) {
                            if let Some((thumb, w, h)) = thumbnail_image_file(p) {
                                image_data = Some(thumb);
                                img_w = w;
                                img_h = h;
                            }
                        }
                    }

                    let entry = ClipboardEntry {
                        id,
                        text: joined,
                        process,
                        process_icon,
                        timestamp: now_millis(),
                        char_count: files.len(),
                        image_data,
                        pinned: false,
                        img_w,
                        img_h,
                        name: None,
                        files: Some(files),
                    };
                    {
                        app.state::<Store>().add_clip(&entry);
                    }
                    let _ = app.emit("clipboard-new", entry);
                    continue;
                }
            }

            // ── Image branch ──
            if let Ok(img) = clipboard.get_image() {
                // Was this our own paste? skip it
                {
                    let g = app.state::<PasteGuard>();
                    let mut skip = g.skip_image.lock().unwrap_or_else(|e| e.into_inner());
                    if *skip {
                        *skip = false;
                        continue;
                    }
                }

                let iw = img.width as u32;
                let ih = img.height as u32;
                let (process, exe_path) = get_foreground_process_info();
                let id = new_id();
                let dir = app.state::<Store>().data_dir.clone();

                if let Some(image_data) = save_image_clip(img, &dir, &id) {
                    if image_data == last_image {
                        // duplicate — discard the original we just wrote
                        let _ = std::fs::remove_file(dir.join("images").join(format!("{id}.png")));
                        continue;
                    }
                    last_image = image_data.clone();

                    let process_icon = if exe_path.is_empty() { None } else { extract_icon_base64(&exe_path) };

                    let entry = ClipboardEntry {
                        id,
                        text: String::new(),
                        process,
                        process_icon,
                        timestamp: now_millis(),
                        char_count: 0,
                        image_data: Some(image_data),
                        pinned: false,
                        img_w: iw,
                        img_h: ih,
                        name: None,
                        files: None,
                    };
                    {
                        app.state::<Store>().add_clip(&entry);
                    }
                    let _ = app.emit("clipboard-new", entry);
                }
                continue;
            }

            // ── Text branch ──
            if let Ok(text) = clipboard.get_text() {
                if text.trim().is_empty() { continue; }

                // Was this our own paste? skip it
                {
                    let g = app.state::<PasteGuard>();
                    let mut t = g.text.lock().unwrap_or_else(|e| e.into_inner());
                    if t.as_deref() == Some(text.as_str()) {
                        *t = None;
                        last_text = text;
                        continue;
                    }
                }

                if text == last_text { continue; } // dedup

                let (process, exe_path) = get_foreground_process_info();
                let char_count = text.chars().count();
                let stored = cap_text(&text);
                let process_icon = if exe_path.is_empty() { None } else { extract_icon_base64(&exe_path) };

                last_text = text;

                let entry = ClipboardEntry {
                    id: new_id(),
                    text: stored,
                    process,
                    process_icon,
                    timestamp: now_millis(),
                    char_count,
                    image_data: None,
                    pinned: false,
                    img_w: 0,
                    img_h: 0,
                    name: None,
                    files: None,
                };
                {
                    app.state::<Store>().add_clip(&entry);
                }
                let _ = app.emit("clipboard-new", entry);
            }
        }
    });
}

// ── No-activate overlay + click-outside dismissal (Windows) ───────────────────
//
// The bar floats without ever becoming the foreground window (WS_EX_NOACTIVATE),
// so showing it and clicking a card never steals focus from the app you're
// pasting into — critical for focus-sensitive popups (1Password, browser
// autofill, etc.) that self-close the instant they lose focus. Because we no
// longer take focus, the old focus-loss auto-hide can't fire, so a low-level
// mouse hook dismisses the bar when a click lands outside it.

#[cfg(target_os = "windows")]
static OVERLAY_HWND: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
#[cfg(target_os = "windows")]
static DISMISS_TX: std::sync::OnceLock<std::sync::mpsc::Sender<()>> = std::sync::OnceLock::new();

/// Add or remove WS_EX_NOACTIVATE. On by default (float without focus); the
/// front-end turns it off via `focus_search` when the user clicks the search
/// box so they can actually type.
#[cfg(target_os = "windows")]
fn set_no_activate(window: &tauri::WebviewWindow, on: bool) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let flag = WS_EX_NOACTIVATE.0 as isize;
            let new = if on { ex | flag } else { ex & !flag };
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
        }
    }
}

/// Low-level mouse hook: when the bar is visible and a click lands outside its
/// rect, signal a dismiss.
#[cfg(target_os = "windows")]
unsafe extern "system" fn mouse_hook_proc(
    code: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetWindowRect, IsWindowVisible, HC_ACTION, MSLLHOOKSTRUCT,
        WM_LBUTTONDOWN, WM_MBUTTONDOWN, WM_RBUTTONDOWN,
    };

    if code == HC_ACTION as i32 {
        let msg = wparam.0 as u32;
        if msg == WM_LBUTTONDOWN || msg == WM_RBUTTONDOWN || msg == WM_MBUTTONDOWN {
            let raw = OVERLAY_HWND.load(Ordering::Relaxed);
            if raw != 0 {
                let hwnd = HWND(raw as *mut c_void);
                if IsWindowVisible(hwnd).as_bool() {
                    let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                    let mut rect = RECT::default();
                    if GetWindowRect(hwnd, &mut rect).is_ok() {
                        let (x, y) = (info.pt.x, info.pt.y);
                        let inside =
                            x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
                        if !inside {
                            if let Some(tx) = DISMISS_TX.get() {
                                let _ = tx.send(());
                            }
                        }
                    }
                }
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Install the click-outside hook (own thread + message pump) and the consumer
/// thread that hides the bar when the hook fires.
#[cfg(target_os = "windows")]
fn install_overlay_dismiss(app: &tauri::AppHandle) {
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, MSG, WH_MOUSE_LL,
    };

    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let _ = DISMISS_TX.set(tx);

    let app_c = app.clone();
    thread::spawn(move || {
        while rx.recv().is_ok() {
            if let Some(window) = app_c.get_webview_window("main") {
                hide_bar(&window);
            }
        }
    });

    thread::spawn(|| unsafe {
        if SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook_proc), None, 0).is_err() {
            return;
        }
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

// ── Window helpers ────────────────────────────────────────────────────────────

/// Show the bar WITHOUT activating it. Tauri's `show()` maps to
/// `ShowWindow(SW_SHOW)`, which activates the window even with WS_EX_NOACTIVATE
/// set — and that activation (plus the focus hand-back on hide) is what
/// re-activates the target's owner and dismisses focus-independent popups like
/// 1Password's. We use raw ShowWindow for both show and hide so visibility stays
/// consistent; going through Tauri for one and raw for the other desyncs tao's
/// internal VISIBLE flag and turns `hide()` into a silent no-op.
#[cfg(target_os = "windows")]
fn show_bar(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, SW_SHOWNOACTIVATE,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            // Force a frame recalculation (without activating/moving) so DWM
            // re-renders the acrylic/mica backdrop — SW_SHOWNOACTIVATE alone
            // doesn't trigger the repaint that Tauri's show() used to.
            let _ = SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
            );
        }
    }
}

#[cfg(target_os = "windows")]
fn hide_bar(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn show_bar(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

#[cfg(not(target_os = "windows"))]
fn hide_bar(window: &tauri::WebviewWindow) {
    let _ = window.hide();
}

fn toggle_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        if visible {
            hide_bar(&window);
        } else {
            // Remember who had focus so we can paste back into it later.
            #[cfg(target_os = "windows")]
            {
                use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
                let hwnd = unsafe { GetForegroundWindow() };
                *app.state::<PrevForeground>().0.lock().unwrap_or_else(|e| e.into_inner()) =
                    hwnd.0 as isize;
                // Re-assert non-activating in case a prior search turned it off.
                set_no_activate(&window, true);
            }
            position_on_active_monitor(&window);
            show_bar(&window);
            // SW_SHOWNOACTIVATE skips the repaint that would render the DWM
            // backdrop, so re-assert it now that the window is visible.
            reassert_backdrop(&window);
        }
    }
}

#[cfg(target_os = "windows")]
fn cursor_pos() -> Option<(i32, i32)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
    unsafe {
        let mut p = POINT::default();
        if GetCursorPos(&mut p).is_ok() { Some((p.x, p.y)) } else { None }
    }
}

#[cfg(not(target_os = "windows"))]
fn cursor_pos() -> Option<(i32, i32)> { None }

/// Place the bar at the bottom of whichever monitor the cursor is on.
fn position_on_active_monitor(window: &tauri::WebviewWindow) {
    let monitors = window.available_monitors().unwrap_or_default();
    let active = cursor_pos()
        .and_then(|(cx, cy)| {
            monitors.iter().find(|m| {
                let p = m.position();
                let s = m.size();
                cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
            }).cloned()
        })
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = active {
        let scale = monitor.scale_factor();
        let screen_w = monitor.size().width;
        let screen_h = monitor.size().height;
        let bar_h = (BAR_HEIGHT_LOGICAL * scale) as u32;
        let _ = window.set_size(PhysicalSize::new(screen_w, bar_h));
        let _ = window.set_position(PhysicalPosition::new(
            monitor.position().x,
            monitor.position().y + (screen_h - bar_h) as i32,
        ));
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed { return; }
                    let target_default = Shortcut::new(Some(Modifiers::SHIFT | Modifiers::ALT), Code::KeyV);
                    let target_win_v = Shortcut::new(Some(Modifiers::SUPER), Code::KeyV);
                    if shortcut == &target_default || shortcut == &target_win_v {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .manage(PasteGuard::new())
        .manage(PrevForeground(Mutex::new(0)))
        .invoke_handler(tauri::generate_handler![
            paste_clip,
            paste_text,
            copy_clip,
            copy_text,
            open_external,
            rename_clip,
            get_history,
            toggle_pin,
            delete_clip,
            clear_history,
            get_theme,
            focus_search,
            hide_window,
            downloader::downloader_ready,
            downloader::setup_downloader,
            downloader::start_download
        ])
        .setup(|app| {
            // Store — must be managed before the watcher starts
            let data_dir = app.path().app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join("clipboard-bar");
            app.manage(Store::new(data_dir));

            // Run at startup — enabled by default on first launch (user can opt out)
            {
                let store = app.state::<Store>();
                if store.get_setting("autostart_init").is_none() {
                    let _ = app.autolaunch().enable();
                    store.set_setting("autostart_init", "1");
                }
            }

            // Resolve theme: explicit override, else follow Windows
            let light = match app.state::<Store>().get_setting("theme").as_deref() {
                Some("light") => true,
                Some("dark") => false,
                _ => windows_is_light(),
            };
            app.manage(ThemeState(Mutex::new(light)));

            // Resolve backdrop material: explicit override, else acrylic.
            let acrylic = !matches!(
                app.state::<Store>().get_setting("backdrop").as_deref(),
                Some("mica")
            );
            app.manage(BackdropState(Mutex::new(acrylic)));

            // Resolve Win+V override setting
            let win_v_override = matches!(
                app.state::<Store>().get_setting("win_v_override").as_deref(),
                Some("1")
            );
            app.manage(WinVOverrideState(Mutex::new(win_v_override)));

            // Shift+Alt+V is the always-on base shortcut, so the app is reachable
            // no matter what state the Win+V override is in.
            let base = Shortcut::new(Some(Modifiers::SHIFT | Modifiers::ALT), Code::KeyV);
            if let Err(e) = app.global_shortcut().register(base) {
                eprintln!("Failed to register global shortcut Shift+Alt+V: {:?}", e);
            }

            // If the Win+V override was left on, also claim Win+V. It only becomes
            // free once Explorer restarts, so retry in the background until it does.
            #[cfg(target_os = "windows")]
            {
                if win_v_override {
                    let win_v = Shortcut::new(Some(Modifiers::SUPER), Code::KeyV);
                    if app.global_shortcut().register(win_v).is_err() {
                        register_win_v_with_retry(app.handle());
                    }
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                apply_theme(&window, light);

                // Float without stealing focus, and dismiss on click-outside.
                #[cfg(target_os = "windows")]
                {
                    use std::sync::atomic::Ordering;
                    set_no_activate(&window, true);
                    if let Ok(hwnd) = window.hwnd() {
                        OVERLAY_HWND.store(hwnd.0 as isize, Ordering::Relaxed);
                    }
                    install_overlay_dismiss(app.handle());
                }

                // Still hide on focus loss for the case where the user clicked the
                // search box (which intentionally activated the window).
                let w = window.clone();
                window.on_window_event(move |event| {
                    if matches!(event, tauri::WindowEvent::Focused(false)) {
                        hide_bar(&w);
                    }
                });
            }

            let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
            let startup_item = CheckMenuItem::with_id(app, "toggle_autostart", "Run at startup", true, autostart_on, None::<&str>)?;
            let light_item = CheckMenuItem::with_id(app, "toggle_theme", "Light mode", true, light, None::<&str>)?;
            let acrylic_item = CheckMenuItem::with_id(app, "toggle_backdrop", "Acrylic", true, acrylic, None::<&str>)?;
            let win_v_item = CheckMenuItem::with_id(app, "toggle_win_v", "Use Win+V", true, win_v_override, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&startup_item, &light_item, &acrylic_item, &win_v_item, &quit])?;
            let li = light_item.clone();
            let si = startup_item.clone();
            let ai = acrylic_item.clone();
            let wi = win_v_item.clone();
            let tooltip = if win_v_override { "Clip — Win+V" } else { "Clip — Shift+Alt+V" };
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .tooltip(tooltip)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    "toggle_theme" => {
                        let new_light = {
                            let ts = app.state::<ThemeState>();
                            let mut cur = ts.0.lock().unwrap_or_else(|e| e.into_inner());
                            *cur = !*cur;
                            *cur
                        };
                        let _ = li.set_checked(new_light);
                        app.state::<Store>().set_setting("theme", if new_light { "light" } else { "dark" });
                        if let Some(window) = app.get_webview_window("main") {
                            apply_theme(&window, new_light);
                        }
                    }
                    "toggle_backdrop" => {
                        let new_acrylic = {
                            let bs = app.state::<BackdropState>();
                            let mut cur = bs.0.lock().unwrap_or_else(|e| e.into_inner());
                            *cur = !*cur;
                            *cur
                        };
                        let _ = ai.set_checked(new_acrylic);
                        app.state::<Store>().set_setting("backdrop", if new_acrylic { "acrylic" } else { "mica" });
                        if let Some(window) = app.get_webview_window("main") {
                            let light = {
                                let ts = app.state::<ThemeState>();
                                let val = *ts.0.lock().unwrap_or_else(|e| e.into_inner());
                                val
                            };
                            apply_backdrop(&window, light, new_acrylic);
                        }
                    }
                    "toggle_win_v" => {
                        let new_override = {
                            let ws = app.state::<WinVOverrideState>();
                            let mut cur = ws.0.lock().unwrap_or_else(|e| e.into_inner());
                            *cur = !*cur;
                            *cur
                        };
                        let _ = wi.set_checked(new_override);
                        app.state::<Store>().set_setting("win_v_override", if new_override { "1" } else { "0" });
                        update_win_v_override(app, new_override);
                    }
                    "toggle_autostart" => {
                        let mgr = app.autolaunch();
                        let enabled = mgr.is_enabled().unwrap_or(false);
                        if enabled { let _ = mgr.disable(); } else { let _ = mgr.enable(); }
                        let now = mgr.is_enabled().unwrap_or(!enabled);
                        let _ = si.set_checked(now);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        toggle_window(tray.app_handle());
                    }
                })
                .build(app)?;

            start_clipboard_watcher(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
