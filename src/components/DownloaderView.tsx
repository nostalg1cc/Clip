import { useEffect, useState } from "react";
import type React from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Card } from "./ClipCard";
import type { ClipboardEntry } from "../clipUtils";
// ── Downloader ───────────────────────────────────────────────────────────────

function setupLabel(stage: string): string {
  switch (stage) {
    case "yt-dlp": return "Downloading yt-dlp…";
    case "ffmpeg": return "Downloading ffmpeg… (this is the big one)";
    case "extracting": return "Unpacking ffmpeg…";
    case "starting": return "Preparing…";
    default: return "Working…";
  }
}
function jobLabel(stage: string, percent: number): string {
  switch (stage) {
    case "queued": return "Queued";
    case "downloading": return `Downloading ${percent.toFixed(0)}%`;
    case "processing": return "Finishing up…";
    case "compressing": return "Compressing to size…";
    case "error": return "Failed";
    default: return "…";
  }
}

interface DlJob { stage: string; percent: number; message?: string }

function jobProgress(job: DlJob): number {
  if (job.stage === "queued") return 0;
  if (job.stage === "downloading") return job.percent;
  return 100;
}

const VIDEO_FORMATS = [
  { value: "mp4", label: "MP4" },
  { value: "webm", label: "WebM" },
  { value: "mkv", label: "MKV" },
  { value: "mov", label: "MOV" },
  { value: "avi", label: "AVI" },
] as const;

const AUDIO_FORMATS = [
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "M4A" },
  { value: "wav", label: "WAV" },
  { value: "flac", label: "FLAC" },
  { value: "opus", label: "Opus" },
  { value: "aac", label: "AAC" },
  { value: "vorbis", label: "Vorbis (.ogg)" },
] as const;

type DownloadFormat = typeof VIDEO_FORMATS[number]["value"] | typeof AUDIO_FORMATS[number]["value"];

function isVideoFormat(format: DownloadFormat): boolean {
  return VIDEO_FORMATS.some((f) => f.value === format);
}

export function DownloaderView({
  downloads, notify, onPin, onDelete, onRename, onContextMenu,
}: {
  downloads: ClipboardEntry[];
  notify: (m: string) => void;
  onPin: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, name: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: ClipboardEntry) => void;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [setup, setSetup] = useState<{ stage: string; error?: string } | null>(null);
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<DownloadFormat>("mp4");
  const [quality, setQuality] = useState("best");
  const [targetMb, setTargetMb] = useState(0);
  const [jobs, setJobs] = useState<Record<string, DlJob>>({});
  const isVideo = isVideoFormat(format);

  useEffect(() => {
    invoke<boolean>("downloader_ready").then(setReady).catch(() => setReady(false));
    const unSetup = listen<{ stage: string; error?: string }>("downloader-setup", (e) => {
      if (e.payload.stage === "done") { setReady(true); setSetup(null); }
      else setSetup(e.payload);
    });
    const unProg = listen<{ id: string; stage: string; percent: number; message?: string }>("download-progress", (e) => {
      const { id, stage, percent, message } = e.payload;
      setJobs((j) => {
        const next = { ...j, [id]: { stage, percent, message } };
        if (stage === "done") delete next[id];
        return next;
      });
      if (stage === "error" && message) notify(message);
    });
    return () => { unSetup.then((f) => f()); unProg.then((f) => f()); };
  }, [notify]);

  const focus = () => { invoke("focus_search").catch(() => {}); };
  const startSetup = () => { setSetup({ stage: "starting" }); invoke("setup_downloader").catch(() => {}); };
  const download = () => {
    const u = url.trim();
    if (!u) return;
    invoke<string>("start_download", { url: u, format, quality, targetMb }).catch(() => notify("Couldn't start download"));
    setUrl("");
  };

  const activeJobs = Object.entries(jobs);

  return (
    <div className="downloader">
      <div className="dl-left">
        {ready === false && !setup && (
          <div className="dl-setup">
            <div className="dl-setup-title">One-time setup</div>
            <p className="dl-setup-text">Downloading uses yt-dlp + ffmpeg (~100 MB). Grab them now?</p>
            <button className="dl-btn primary" onClick={startSetup}>Set up downloader</button>
          </div>
        )}
        {setup && (
          <div className="dl-setup">
            <div className="dl-setup-title">{setup.error ? "Setup failed" : "Setting up…"}</div>
            <p className="dl-setup-text">{setup.error ?? setupLabel(setup.stage)}</p>
            {setup.error
              ? <button className="dl-btn" onClick={startSetup}>Retry</button>
              : <div className="dl-spinner" />}
          </div>
        )}
        {ready && (
          <>
            <input
              className="dl-url" placeholder="Paste a link (YouTube, X, …)"
              value={url} onMouseDown={focus}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") download(); e.stopPropagation(); }}
            />
            <label className="dl-field"><span>Format</span>
              <select value={format} onMouseDown={focus} onChange={(e) => setFormat(e.target.value as DownloadFormat)}>
                <optgroup label="Video">
                  {VIDEO_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </optgroup>
                <optgroup label="Audio">
                  {AUDIO_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </optgroup>
              </select>
            </label>
            {isVideo && (
              <label className="dl-field"><span>Quality</span>
                <select value={quality} onMouseDown={focus} onChange={(e) => setQuality(e.target.value)}>
                  <option value="best">Best</option>
                  <option value="2160">4K</option>
                  <option value="1440">1440p</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                </select>
              </label>
            )}
            {format === "mp4" && (
              <label className="dl-field"><span>Fit to size</span>
                <select value={targetMb} onMouseDown={focus} onChange={(e) => setTargetMb(Number(e.target.value))}>
                  <option value={0}>No limit</option>
                  <option value={10}>Discord · 10 MB</option>
                  <option value={25}>25 MB</option>
                  <option value={50}>50 MB</option>
                  <option value={100}>100 MB</option>
                </select>
              </label>
            )}
            <button className="dl-btn primary" onClick={download} disabled={!url.trim()}>Download</button>
            {activeJobs.length > 0 && (
              <div className="dl-jobs">
                {activeJobs.map(([id, j]) => (
                  <div className={`dl-job${j.stage === "error" ? " err" : ""}`} key={id}>
                    <div className="dl-job-bar">
                      <div className="dl-job-fill" style={{ width: `${jobProgress(j)}%` }} />
                    </div>
                    <span className="dl-job-label">{jobLabel(j.stage, j.percent)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
      <div className="dl-right">
        {downloads.length === 0 ? (
          <div className="empty-state">Downloads land here<br />(kept for 24h)</div>
        ) : (
          downloads.map((entry) => (
            <Card key={entry.id} entry={entry} onPin={onPin} onDelete={onDelete} onRename={onRename} onContextMenu={onContextMenu} />
          ))
        )}
      </div>
    </div>
  );
}
