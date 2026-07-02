//! Media downloader — fetches yt-dlp + ffmpeg on first use (via Windows' built-in
//! curl/tar, so no extra Rust deps), downloads any yt-dlp-supported URL as MP4 or
//! MP3, optionally compresses video to a target size, and registers the result as
//! a normal (pasteable, 24h-TTL) clip.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use base64::Engine;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{ClipboardEntry, Store};
use crate::{new_id, now_millis};

const YTDLP_URL: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
const FFMPEG_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip";

// ── Paths ──────────────────────────────────────────────────────────────────────

fn bin_dir(app: &AppHandle) -> PathBuf {
    app.state::<Store>().data_dir.join("bin")
}
fn downloads_dir(app: &AppHandle) -> PathBuf {
    app.state::<Store>().data_dir.join("downloads")
}
fn ytdlp_path(app: &AppHandle) -> PathBuf {
    bin_dir(app).join("yt-dlp.exe")
}
fn ffmpeg_path(app: &AppHandle) -> PathBuf {
    bin_dir(app).join("ffmpeg.exe")
}
fn ffprobe_path(app: &AppHandle) -> PathBuf {
    bin_dir(app).join("ffprobe.exe")
}

/// Build a Command that never flashes a console window.
fn hidden(program: &Path) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

fn hidden_str(program: &str) -> Command {
    hidden(Path::new(program))
}

// ── Setup (download the binaries on first use) ──────────────────────────────────

/// True once yt-dlp and ffmpeg are present.
#[tauri::command]
pub fn downloader_ready(app: AppHandle) -> bool {
    ytdlp_path(&app).exists() && ffmpeg_path(&app).exists()
}

fn emit_setup(app: &AppHandle, stage: &str, error: Option<&str>) {
    let _ = app.emit("downloader-setup", json!({ "stage": stage, "error": error }));
}

/// Download + extract yt-dlp and ffmpeg into the app-data bin dir. Runs on a
/// background thread and reports progress via the `downloader-setup` event.
#[tauri::command]
pub fn setup_downloader(app: AppHandle) {
    thread::spawn(move || {
        let bin = bin_dir(&app);
        if std::fs::create_dir_all(&bin).is_err() {
            emit_setup(&app, "error", Some("Couldn't create the tools folder."));
            return;
        }
        emit_setup(&app, "starting", None);

        // 1) yt-dlp — a single standalone exe.
        if !ytdlp_path(&app).exists() {
            emit_setup(&app, "yt-dlp", None);
            let ok = hidden_str("curl")
                .args([
                    "-L",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "-o",
                    &ytdlp_path(&app).to_string_lossy(),
                    YTDLP_URL,
                ])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok || !ytdlp_path(&app).exists() {
                emit_setup(&app, "error", Some("Failed to download yt-dlp."));
                return;
            }
        }

        // 2) ffmpeg — ships as a zip; download then extract with tar.
        if !ffmpeg_path(&app).exists() {
            emit_setup(&app, "ffmpeg", None);
            let zip = bin.join("ffmpeg.zip");
            let ok = hidden_str("curl")
                .args([
                    "-L",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "-o",
                    &zip.to_string_lossy(),
                    FFMPEG_URL,
                ])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !ok || !zip.exists() {
                emit_setup(&app, "error", Some("Failed to download ffmpeg."));
                return;
            }

            emit_setup(&app, "extracting", None);
            let extracted = bin.join("ffmpeg_extract");
            let _ = std::fs::create_dir_all(&extracted);
            let untar = hidden_str("tar")
                .args(["-xf", &zip.to_string_lossy(), "-C", &extracted.to_string_lossy()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
            if !untar {
                emit_setup(&app, "error", Some("Failed to extract ffmpeg."));
                return;
            }

            // The archive nests bin/ffmpeg.exe + bin/ffprobe.exe under a versioned
            // folder — find and lift them out.
            let mut found_ffmpeg = false;
            let mut found_ffprobe = false;
            find_and_copy(&extracted, "ffmpeg.exe", &ffmpeg_path(&app), &mut found_ffmpeg);
            find_and_copy(&extracted, "ffprobe.exe", &ffprobe_path(&app), &mut found_ffprobe);

            let _ = std::fs::remove_dir_all(&extracted);
            let _ = std::fs::remove_file(&zip);

            if !found_ffmpeg {
                emit_setup(&app, "error", Some("ffmpeg.exe not found in the archive."));
                return;
            }
        }

        emit_setup(&app, "done", None);
    });
}

/// Recursively look for `name` under `dir` and copy the first match to `dest`.
fn find_and_copy(dir: &Path, name: &str, dest: &Path, found: &mut bool) {
    if *found {
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            find_and_copy(&path, name, dest, found);
        } else if path.file_name().and_then(|n| n.to_str()) == Some(name) {
            if std::fs::copy(&path, dest).is_ok() {
                *found = true;
            }
        }
        if *found {
            return;
        }
    }
}

// ── Download ────────────────────────────────────────────────────────────────────

fn emit_progress(app: &AppHandle, id: &str, stage: &str, percent: f64, message: Option<&str>) {
    let _ = app.emit(
        "download-progress",
        json!({ "id": id, "stage": stage, "percent": percent, "message": message }),
    );
}

/// Kick off a download. Returns a job id immediately; progress and completion are
/// reported via the `download-progress` event, and the finished clip via
/// `clipboard-new` (so it shows up like any other clip).
#[tauri::command]
pub fn start_download(
    app: AppHandle,
    url: String,
    format: String,   // "mp4" | "mp3"
    quality: String,  // "best" | "2160" | "1440" | "1080" | "720" | "480"
    target_mb: u32,   // 0 = no compression
) -> String {
    let id = new_id();
    let job = id.clone();
    thread::spawn(move || {
        run_download(&app, &job, &url, &format, &quality, target_mb);
    });
    id
}

fn run_download(app: &AppHandle, id: &str, url: &str, format: &str, quality: &str, target_mb: u32) {
    let dl_dir = downloads_dir(app);
    if std::fs::create_dir_all(&dl_dir).is_err() {
        emit_progress(app, id, "error", 0.0, Some("Couldn't create the downloads folder."));
        return;
    }

    let is_audio = format == "mp3";
    let out_tmpl = dl_dir.join(format!("{id}.%(ext)s"));
    let ffmpeg_dir = bin_dir(app);

    let mut cmd = hidden(&ytdlp_path(app));
    cmd.args([
        "--no-playlist",
        "--no-part",
        "--force-overwrites",
        "--newline",
        "--progress-template",
        "PROG:%(progress._percent_str)s",
        "--print",
        "TITLE:%(title)s",
        "--ffmpeg-location",
        &ffmpeg_dir.to_string_lossy(),
        "-o",
        &out_tmpl.to_string_lossy(),
        "--write-thumbnail",
        "--convert-thumbnails",
        "jpg",
    ]);
    if is_audio {
        cmd.args(["-x", "--audio-format", "mp3", "--audio-quality", "0"]);
    } else {
        cmd.args(["-f", "bv*+ba/b", "--merge-output-format", "mp4"]);
        if quality != "best" {
            cmd.args(["-S", &format!("res:{quality}")]);
        }
    }
    cmd.arg(url);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    emit_progress(app, id, "downloading", 0.0, None);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => {
            emit_progress(app, id, "error", 0.0, Some("Couldn't start yt-dlp."));
            return;
        }
    };

    let title = std::sync::Arc::new(std::sync::Mutex::new(String::new()));

    // stdout — capture the title.
    let stdout_handle = {
        let title = title.clone();
        let stdout = child.stdout.take();
        thread::spawn(move || {
            if let Some(out) = stdout {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    if let Some(t) = line.strip_prefix("TITLE:") {
                        *title.lock().unwrap_or_else(|e| e.into_inner()) = t.trim().to_string();
                    }
                }
            }
        })
    };

    // stderr — parse progress percentages.
    let stderr_handle = {
        let app = app.clone();
        let id = id.to_string();
        let stderr = child.stderr.take();
        thread::spawn(move || {
            if let Some(err) = stderr {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    if let Some(p) = line.strip_prefix("PROG:") {
                        let pct: f64 = p.trim().trim_end_matches('%').trim().parse().unwrap_or(0.0);
                        emit_progress(&app, &id, "downloading", pct, None);
                    }
                }
            }
        })
    };

    let success = child.wait().map(|s| s.success()).unwrap_or(false);
    let _ = stdout_handle.join();
    let _ = stderr_handle.join();

    if !success {
        emit_progress(app, id, "error", 0.0, Some("Download failed (unsupported or private link?)."));
        return;
    }

    // Locate the produced media file.
    let media_ext = if is_audio { "mp3" } else { "mp4" };
    let mut media_path = dl_dir.join(format!("{id}.{media_ext}"));
    if !media_path.exists() {
        // Fall back to any non-thumbnail file with our id prefix.
        if let Some(p) = find_media_file(&dl_dir, id) {
            media_path = p;
        } else {
            emit_progress(app, id, "error", 0.0, Some("Finished, but the file went missing."));
            return;
        }
    }

    // Optional compression (video only).
    if !is_audio && target_mb > 0 {
        emit_progress(app, id, "compressing", 100.0, None);
        compress_to_size(app, &media_path, target_mb);
    } else {
        emit_progress(app, id, "processing", 100.0, None);
    }

    // Thumbnail → base64 data URL, then discard the jpg.
    let thumb_path = dl_dir.join(format!("{id}.jpg"));
    let image_data = std::fs::read(&thumb_path).ok().map(|bytes| {
        format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes))
    });
    let _ = std::fs::remove_file(&thumb_path);

    let title = {
        let t = title.lock().unwrap_or_else(|e| e.into_inner()).clone();
        if t.is_empty() { url.to_string() } else { t }
    };
    let size_bytes = std::fs::metadata(&media_path).map(|m| m.len()).unwrap_or(0);

    let entry = ClipboardEntry {
        id: id.to_string(),
        text: title.clone(),
        process: "Downloader".to_string(),
        process_icon: None,
        timestamp: now_millis(),
        char_count: size_bytes as usize,
        image_data,
        pinned: false,
        img_w: 0,
        img_h: 0,
        name: Some(title),
        files: Some(vec![media_path.to_string_lossy().to_string()]),
    };
    app.state::<Store>().add_clip(&entry);
    let _ = app.emit("clipboard-new", entry);
    emit_progress(app, id, "done", 100.0, None);
}

/// Find our download's media file (any file starting with `{id}.` that isn't a
/// thumbnail image).
fn find_media_file(dir: &Path, id: &str) -> Option<PathBuf> {
    let prefix = format!("{id}.");
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        let name = path.file_name()?.to_string_lossy().to_string();
        if name.starts_with(&prefix) {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
            if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                return Some(path);
            }
        }
    }
    None
}

// ── Compression (two-pass H.264 targeting a byte budget) ────────────────────────

fn probe_duration(app: &AppHandle, file: &Path) -> Option<f64> {
    let out = hidden(&ffprobe_path(app))
        .args([
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
        ])
        .arg(file)
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse::<f64>().ok()
}

/// Re-encode `file` in place to fit under `target_mb`. Best-effort: on any failure
/// the original download is kept.
fn compress_to_size(app: &AppHandle, file: &Path, target_mb: u32) {
    let duration = match probe_duration(app, file) {
        Some(d) if d > 0.5 => d,
        _ => return,
    };

    // Leave ~6% headroom for container overhead; reserve 128 kbps for audio.
    let audio_kbps = 128.0;
    let total_kbit = (target_mb as f64) * 8192.0 * 0.94;
    let video_kbps = (total_kbit / duration - audio_kbps).max(120.0);
    let v = format!("{}k", video_kbps.round() as i64);

    let dir = file.parent().unwrap_or_else(|| Path::new("."));
    let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("out");
    let passlog = dir.join(format!("{stem}_pass"));
    let out = dir.join(format!("{stem}_c.mp4"));
    let null = if cfg!(target_os = "windows") { "NUL" } else { "/dev/null" };

    // Pass 1 (analysis, no audio, discard output).
    let p1 = hidden(&ffmpeg_path(app))
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(file)
        .args(["-c:v", "libx264", "-b:v", &v, "-pass", "1", "-passlogfile"])
        .arg(&passlog)
        .args(["-an", "-f", "mp4", null])
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !p1 {
        cleanup_pass(&passlog);
        return;
    }

    // Pass 2 (real encode with audio).
    let p2 = hidden(&ffmpeg_path(app))
        .args(["-y", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(file)
        .args(["-c:v", "libx264", "-b:v", &v, "-pass", "2", "-passlogfile"])
        .arg(&passlog)
        .args(["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"])
        .arg(&out)
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    cleanup_pass(&passlog);

    if p2 && out.exists() {
        // Replace the original with the compressed version.
        let _ = std::fs::remove_file(file);
        let _ = std::fs::rename(&out, file);
    } else {
        let _ = std::fs::remove_file(&out);
    }
}

fn cleanup_pass(passlog: &Path) {
    let dir = passlog.parent().unwrap_or_else(|| Path::new("."));
    if let Some(prefix) = passlog.file_name().and_then(|n| n.to_str()) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(prefix) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }
}
