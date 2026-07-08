use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

use crate::store::{ClipboardEntry, Store};
use crate::{new_id, now_millis, save_image_clip};

/// The full-monitor frame grabbed the instant the hotkey fires, before the
/// overlay window ever touches the screen. `capture_finish_selection` crops
/// straight out of this once the user finishes dragging.
pub struct CaptureState(pub Mutex<Option<image::DynamicImage>>);
impl CaptureState {
    pub fn new() -> Self { Self(Mutex::new(None)) }
}

#[cfg(target_os = "windows")]
fn capture_region_bitmap(x: i32, y: i32, w: i32, h: i32) -> Option<image::DynamicImage> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    };

    unsafe {
        let screen_dc = GetDC(None);
        let mem_dc = CreateCompatibleDC(Some(screen_dc));
        let bitmap = CreateCompatibleBitmap(screen_dc, w, h);
        SelectObject(mem_dc, HGDIOBJ(bitmap.0));
        let _ = BitBlt(mem_dc, 0, 0, w, h, Some(screen_dc), x, y, SRCCOPY);

        let mut bmi = std::mem::zeroed::<BITMAPINFO>();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = 0;

        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        GetDIBits(mem_dc, bitmap, 0, h as u32, Some(pixels.as_mut_ptr() as _), &mut bmi, DIB_RGB_COLORS);

        let _ = DeleteDC(mem_dc);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = ReleaseDC(None, screen_dc);

        for chunk in pixels.chunks_mut(4) { chunk.swap(0, 2); } // BGRA -> RGBA

        image::RgbaImage::from_raw(w as u32, h as u32, pixels).map(image::DynamicImage::ImageRgba8)
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_region_bitmap(_x: i32, _y: i32, _w: i32, _h: i32) -> Option<image::DynamicImage> {
    None
}

/// On-device OCR via Windows' own Media.Ocr engine — same one PowerToys'
/// Text Extractor and Snip & Sketch use. No network call, no bundled model;
/// needs the OCR language pack for the user's profile language, which is
/// installed by default alongside the display language on virtually all setups.
#[cfg(target_os = "windows")]
fn ocr_image(img: &image::DynamicImage) -> Option<String> {
    use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
    use windows::Media::Ocr::OcrEngine;
    use windows::Storage::Streams::DataWriter;

    let rgba = img.to_rgba8();
    let (w, h) = (rgba.width() as i32, rgba.height() as i32);

    let writer = DataWriter::new().ok()?;
    writer.WriteBytes(rgba.as_raw()).ok()?;
    let buffer = writer.DetachBuffer().ok()?;

    let raw_bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Rgba8, w, h).ok()?;
    // OcrEngine wants Bgra8/Premultiplied specifically — Convert handles the
    // repack regardless of what format we handed it in.
    let bitmap = SoftwareBitmap::Convert(&raw_bitmap, BitmapPixelFormat::Bgra8).ok()?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
    let result = engine.RecognizeAsync(&bitmap).ok()?.get().ok()?;
    let text = result.Text().ok()?.to_string();
    if text.trim().is_empty() { None } else { Some(text) }
}

#[cfg(not(target_os = "windows"))]
fn ocr_image(_img: &image::DynamicImage) -> Option<String> { None }

/// DWM's default open/close fade is what made the overlay feel laggy on top
/// of anything else — this makes show/hide instant regardless of trigger.
#[cfg(target_os = "windows")]
fn disable_window_animations(window: &tauri::WebviewWindow) {
    use windows::core::BOOL;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_TRANSITIONS_FORCEDISABLED};
    if let Ok(hwnd) = window.hwnd() {
        let disable = BOOL(1);
        unsafe {
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TRANSITIONS_FORCEDISABLED,
                &disable as *const _ as *const std::ffi::c_void,
                std::mem::size_of::<BOOL>() as u32,
            );
        }
    }
}
#[cfg(not(target_os = "windows"))]
fn disable_window_animations(_window: &tauri::WebviewWindow) {}

/// Raw show/hide (activating, unlike the main bar's SW_SHOWNOACTIVATE — this
/// overlay needs real keyboard/mouse focus) instead of Tauri's own
/// show()/hide(), which can still carry a visible transition of its own.
#[cfg(target_os = "windows")]
fn show_overlay(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOW};
    if let Ok(hwnd) = window.hwnd() {
        unsafe { let _ = ShowWindow(hwnd, SW_SHOW); }
    }
}
#[cfg(not(target_os = "windows"))]
fn show_overlay(window: &tauri::WebviewWindow) { let _ = window.show(); }

#[cfg(target_os = "windows")]
fn hide_overlay(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(hwnd) = window.hwnd() {
        unsafe { let _ = ShowWindow(hwnd, SW_HIDE); }
    }
}
#[cfg(not(target_os = "windows"))]
fn hide_overlay(window: &tauri::WebviewWindow) { let _ = window.hide(); }

/// Hotkey entry point. The pixel grab happens BEFORE the overlay window ever
/// exists on screen — that's what makes video content capture correctly (a
/// window sitting on top of a hardware-composited video plane, even a fully
/// transparent one, makes DWM stop compositing it correctly). But the grab
/// itself is fast (a plain BitBlt); the SLOW part is JPEG-encoding a
/// multi-megapixel frame and shipping it over IPC, and that must not happen
/// before show()/set_focus() — Windows grants a brief "steal foreground
/// focus" allowance tied to the input event that triggered the hotkey, and
/// any real delay before actually claiming it (encoding + base64 + IPC took
/// long enough) gets it silently revoked: the overlay ends up visible but
/// keyboard-dead, which is exactly what "Escape/T don't work" turned out to
/// be. So: grab -> show+focus immediately -> encode+ship in the background.
pub fn start_screen_capture(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(overlay) = app.get_webview_window("capture") else { return };
        if overlay.is_visible().unwrap_or(false) {
            return; // capture already in progress
        }

        let monitor = crate::cursor_pos()
            .and_then(|(cx, cy)| {
                overlay.available_monitors().ok()?.into_iter().find(|m| {
                    let p = m.position();
                    let s = m.size();
                    cx >= p.x && cx < p.x + s.width as i32 && cy >= p.y && cy < p.y + s.height as i32
                })
            })
            .or_else(|| overlay.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else { return };

        let pos = *monitor.position();
        let size = *monitor.size();

        let Some(img) = capture_region_bitmap(pos.x, pos.y, size.width as i32, size.height as i32) else {
            eprintln!("Screen capture: capture_region_bitmap returned None");
            return;
        };

        disable_window_animations(&overlay);
        let _ = overlay.set_position(PhysicalPosition::new(pos.x, pos.y));
        let _ = overlay.set_size(PhysicalSize::new(size.width, size.height));
        show_overlay(&overlay);
        let _ = overlay.set_focus();

        let app2 = app.clone();
        let overlay2 = overlay.clone();
        std::thread::spawn(move || {
            use image::ImageEncoder;
            let mut jpg = Vec::new();
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 90);
            let rgb8 = img.to_rgb8();
            if let Err(e) = encoder.write_image(rgb8.as_raw(), rgb8.width(), rgb8.height(), image::ExtendedColorType::Rgb8) {
                eprintln!("Screen capture: JPEG encode failed: {e:?}");
                return;
            }
            use base64::Engine;
            let data_url = format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&jpg));

            *app2.state::<CaptureState>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(img);
            let _ = app2.run_on_main_thread(move || {
                let _ = overlay2.emit_to("capture", "capture-frame", data_url);
            });
        });
    });
}

#[tauri::command]
pub fn capture_cancel(app: AppHandle) {
    *app.state::<CaptureState>().0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    if let Some(w) = app.get_webview_window("capture") {
        hide_overlay(&w);
    }
}

/// x/y/width/height are physical pixels within the captured monitor frame
/// (the overlay converts from CSS px via devicePixelRatio before calling this).
#[tauri::command]
pub fn capture_finish_selection(app: AppHandle, x: u32, y: u32, width: u32, height: u32, mode: String) {
    let img = app.state::<CaptureState>().0.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(w) = app.get_webview_window("capture") {
        hide_overlay(&w);
    }
    let Some(img) = img else { return };
    if width == 0 || height == 0 { return; }

    let img = img.crop_imm(x, y, width, height);

    let store = app.state::<Store>();
    let entry = if mode == "text" {
        let Some(text) = ocr_image(&img) else {
            eprintln!("Screen capture: OCR found no text in the selected region");
            return;
        };
        ClipboardEntry {
            id: new_id(),
            char_count: text.chars().count(),
            text,
            process: "Screenshot".into(),
            process_icon: None,
            timestamp: now_millis(),
            image_data: None,
            pinned: false,
            img_w: 0,
            img_h: 0,
            name: None,
            files: None,
        }
    } else {
        let rgba = img.to_rgba8();
        let (w, h) = (rgba.width(), rgba.height());
        let arboard_img = arboard::ImageData {
            width: w as usize,
            height: h as usize,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        };
        let id = new_id();
        let dir = store.data_dir.clone();
        let Some(image_data) = save_image_clip(arboard_img, &dir, &id) else { return };
        ClipboardEntry {
            id,
            text: String::new(),
            process: "Screenshot".into(),
            process_icon: None,
            timestamp: now_millis(),
            char_count: 0,
            image_data: Some(image_data),
            pinned: false,
            img_w: w,
            img_h: h,
            name: None,
            files: None,
        }
    };
    store.add_clip(&entry);
    let _ = app.emit("clipboard-new", entry);

    // Intentionally not revealing the main bar here yet — this is being
    // tested standalone first.
}
