use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize};

use crate::store::{ClipboardEntry, Store};
use crate::{new_id, now_millis, save_image_clip};

struct PendingCapture {
    id: u64,
    image: image::DynamicImage,
}

/// The full-monitor frame grabbed the instant the hotkey fires, before the
/// overlay window ever touches the screen. `capture_finish_selection` crops
/// straight out of this once the user finishes dragging.
pub struct CaptureState {
    current: Mutex<Option<PendingCapture>>,
    next_id: AtomicU64,
}

impl CaptureState {
    pub fn new() -> Self {
        Self {
            current: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    fn begin(&self, image: image::DynamicImage) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) =
            Some(PendingCapture { id, image });
        id
    }

    fn cancel(&self) {
        *self.current.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }

    fn is_current(&self, id: u64) -> bool {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .is_some_and(|capture| capture.id == id)
    }

    fn take_current(&self) -> Option<image::DynamicImage> {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
            .map(|capture| capture.image)
    }
}

#[cfg(target_os = "windows")]
fn capture_region_bitmap(x: i32, y: i32, w: i32, h: i32) -> Option<image::DynamicImage> {
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ,
        SRCCOPY,
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
        GetDIBits(
            mem_dc,
            bitmap,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as _),
            &mut bmi,
            DIB_RGB_COLORS,
        );

        let _ = DeleteDC(mem_dc);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = ReleaseDC(None, screen_dc);

        for chunk in pixels.chunks_mut(4) {
            chunk.swap(0, 2);
        } // BGRA -> RGBA

        image::RgbaImage::from_raw(w as u32, h as u32, pixels).map(image::DynamicImage::ImageRgba8)
    }
}

#[cfg(not(target_os = "windows"))]
fn capture_region_bitmap(_x: i32, _y: i32, _w: i32, _h: i32) -> Option<image::DynamicImage> {
    None
}

fn clamp_crop(
    img_w: u32,
    img_h: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Option<(u32, u32, u32, u32)> {
    if img_w == 0 || img_h == 0 || width == 0 || height == 0 {
        return None;
    }
    let x = x.min(img_w);
    let y = y.min(img_h);
    let right = x.saturating_add(width).min(img_w);
    let bottom = y.saturating_add(height).min(img_h);
    let width = right.saturating_sub(x);
    let height = bottom.saturating_sub(y);
    if width == 0 || height == 0 {
        None
    } else {
        Some((x, y, width, height))
    }
}

/// On-device OCR via Windows' own Media.Ocr engine, the same engine used by
/// PowerToys Text Extractor and Snip & Sketch.
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

    let raw_bitmap =
        SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Rgba8, w, h).ok()?;
    let bitmap = SoftwareBitmap::Convert(&raw_bitmap, BitmapPixelFormat::Bgra8).ok()?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages().ok()?;
    let result = engine.RecognizeAsync(&bitmap).ok()?.get().ok()?;
    let text = result.Text().ok()?.to_string();
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(not(target_os = "windows"))]
fn ocr_image(_img: &image::DynamicImage) -> Option<String> {
    None
}

/// DWM's default open/close fade makes the overlay feel laggy. This makes
/// show/hide instant regardless of trigger.
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

#[cfg(target_os = "windows")]
fn show_overlay(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOW};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOW);
        }
    }
}
#[cfg(not(target_os = "windows"))]
fn show_overlay(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

#[cfg(target_os = "windows")]
fn hide_overlay(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
}
#[cfg(not(target_os = "windows"))]
fn hide_overlay(window: &tauri::WebviewWindow) {
    let _ = window.hide();
}

/// Hotkey entry point. The pixel grab happens before the overlay is shown, then
/// the stored frame is encoded in the background for display.
pub fn start_screen_capture(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        let Some(overlay) = app.get_webview_window("capture") else {
            return;
        };
        if overlay.is_visible().unwrap_or(false) {
            return;
        }

        let monitor = crate::cursor_pos()
            .and_then(|(cx, cy)| {
                overlay.available_monitors().ok()?.into_iter().find(|m| {
                    let p = m.position();
                    let s = m.size();
                    cx >= p.x
                        && cx < p.x + s.width as i32
                        && cy >= p.y
                        && cy < p.y + s.height as i32
                })
            })
            .or_else(|| overlay.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else { return };

        let pos = *monitor.position();
        let size = *monitor.size();

        let Some(img) = capture_region_bitmap(pos.x, pos.y, size.width as i32, size.height as i32)
        else {
            eprintln!("Screen capture: capture_region_bitmap returned None");
            return;
        };

        let capture_id = app.state::<CaptureState>().begin(img.clone());

        disable_window_animations(&overlay);
        let _ = overlay.emit_to("capture", "capture-reset", ());
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
            if let Err(e) = encoder.write_image(
                rgb8.as_raw(),
                rgb8.width(),
                rgb8.height(),
                image::ExtendedColorType::Rgb8,
            ) {
                eprintln!("Screen capture: JPEG encode failed: {e:?}");
                return;
            }
            if !app2.state::<CaptureState>().is_current(capture_id) {
                return;
            }
            use base64::Engine;
            let data_url = format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&jpg)
            );

            let _ = app2.run_on_main_thread(move || {
                let _ = overlay2.emit_to("capture", "capture-frame", data_url);
            });
        });
    });
}

#[tauri::command]
pub fn capture_cancel(app: AppHandle) {
    app.state::<CaptureState>().cancel();
    if let Some(w) = app.get_webview_window("capture") {
        hide_overlay(&w);
    }
}

/// x/y/width/height are physical pixels within the captured monitor frame
/// (the overlay converts from CSS px via devicePixelRatio before calling this).
#[tauri::command]
pub fn capture_finish_selection(
    app: AppHandle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    mode: String,
) {
    let img = app.state::<CaptureState>().take_current();
    if let Some(w) = app.get_webview_window("capture") {
        hide_overlay(&w);
    }
    let Some(img) = img else { return };
    let Some((x, y, width, height)) = clamp_crop(img.width(), img.height(), x, y, width, height)
    else {
        return;
    };

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
        let Some(image_data) = save_image_clip(arboard_img, &dir, &id) else {
            return;
        };
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
}

#[cfg(test)]
mod tests {
    use super::clamp_crop;

    #[test]
    fn crop_is_clamped_to_image_bounds() {
        assert_eq!(clamp_crop(100, 80, 90, 70, 50, 30), Some((90, 70, 10, 10)));
    }

    #[test]
    fn crop_outside_image_is_rejected() {
        assert_eq!(clamp_crop(100, 80, 100, 20, 10, 10), None);
        assert_eq!(clamp_crop(100, 80, 20, 80, 10, 10), None);
    }
}
