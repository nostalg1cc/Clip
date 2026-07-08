import { memo, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  KIND_FALLBACK_COLOR,
  KIND_LABEL,
  cachedCodeInfoFor,
  colorCache,
  colorFormats,
  dominantColor,
  domainOf,
  effectiveKind,
  langDisplayName,
  metaText,
  parseColor,
  processColor,
  renderMarkdown,
  timeAgo,
  type ClipboardEntry,
  type Kind,
} from "../clipUtils";
// ── Tilt ────────────────────────────────────────────────────────────────────────

function handleTiltMove(e: React.MouseEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  el.style.setProperty("--rx", `${((0.5 - py) * 11).toFixed(2)}deg`);
  el.style.setProperty("--ry", `${((px - 0.5) * 11).toFixed(2)}deg`);
  el.classList.add("tilting");
}
function handleTiltLeave(e: React.MouseEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  el.style.setProperty("--rx", "0deg");
  el.style.setProperty("--ry", "0deg");
  el.classList.remove("tilting");
}

// Glint sweep on pinned cards — starts on hover-enter, always plays to completion
function handleCardEnter(e: React.MouseEvent<HTMLDivElement>) {
  const el = e.currentTarget;
  if (el.classList.contains("is-pinned")) el.classList.add("glint");
}
function handleGlintEnd(e: React.AnimationEvent<HTMLDivElement>) {
  if (e.animationName === "glint") e.currentTarget.classList.remove("glint");
}

// ── SVG Icons ─────────────────────────────────────────────────────────────────

const PinIcon = ({ filled }: { filled: boolean }) => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="17" x2="12" y2="22" />
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
  </svg>
);
const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    <path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
  </svg>
);
const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);
const MailGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="4" width="20" height="16" rx="2" /><path d="M22 7l-10 6L2 7" />
  </svg>
);
const PhoneGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z" />
  </svg>
);
const FolderGlyph = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);
const FileGlyph = () => (
  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
  </svg>
);
const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
  </svg>
);
const RevealIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </svg>
);
const PlayBadge = () => (
  <svg viewBox="0 0 68 48" width="54" height="40" aria-hidden="true">
    <path d="M66.5 7.7a8 8 0 0 0-5.6-5.7C56 .7 34 .7 34 .7s-22 0-26.9 1.3A8 8 0 0 0 1.5 7.7 83 83 0 0 0 .2 24a83 83 0 0 0 1.3 16.3 8 8 0 0 0 5.6 5.7C12 47.3 34 47.3 34 47.3s22 0 26.9-1.3a8 8 0 0 0 5.6-5.7A83 83 0 0 0 67.8 24a83 83 0 0 0-1.3-16.3z" fill="#f00" />
    <path d="M27 34.5 45.5 24 27 13.5z" fill="#fff" />
  </svg>
);

// ── Reusable action buttons ─────────────────────────────────────────────────────

function PinButton({ pinned, onPin }: { pinned: boolean; onPin: () => void }) {
  return (
    <button className={`action-btn pin-btn${pinned ? " pinned" : ""}`}
      onClick={(e) => { e.stopPropagation(); onPin(); }} aria-label={pinned ? "Unpin" : "Pin"}>
      <PinIcon filled={pinned} />
    </button>
  );
}
function DeleteButton({ onDelete }: { onDelete: (e: React.MouseEvent) => void }) {
  const [confirm, setConfirm] = useState(false);
  const t = useRef<number | undefined>(undefined);
  const click = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm) { setConfirm(false); onDelete(e); }
    else { setConfirm(true); window.clearTimeout(t.current); t.current = window.setTimeout(() => setConfirm(false), 2200); }
  };
  return (
    <button className={`action-btn delete-btn${confirm ? " confirm" : ""}`} onClick={click}
      aria-label={confirm ? "Confirm delete" : "Delete"}>
      {confirm ? <CheckIcon /> : <TrashIcon />}
    </button>
  );
}

// ── Link helpers ─────────────────────────────────────────────────────────────────

interface LinkMeta { title?: string; thumb?: string; author?: string }
function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.endsWith("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      if (u.pathname.startsWith("/shorts/")) return u.pathname.split("/")[2] || null;
      if (u.pathname.startsWith("/embed/")) return u.pathname.split("/")[2] || null;
    }
  } catch { /* ignore */ }
  return null;
}
function loadLinkMeta(url: string): LinkMeta | null {
  try { const v = localStorage.getItem("linkmeta:" + url); return v ? JSON.parse(v) : null; } catch { return null; }
}
function saveLinkMeta(url: string, m: LinkMeta) {
  try { localStorage.setItem("linkmeta:" + url, JSON.stringify(m)); } catch { /* quota */ }
}

// ── Card body (non-media kinds) ─────────────────────────────────────────────────

function CardBody({ kind, entry, codeHtml }: { kind: Kind; entry: ClipboardEntry; codeHtml: string | null }) {
  if (codeHtml !== null)
    return <pre className="card-code hljs" dangerouslySetInnerHTML={{ __html: codeHtml }} />;
  if (kind === "markdown")
    return <div className="card-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.text) }} />;
  if (kind === "csv") {
    const rows = entry.text.trim().split(/\r?\n/).slice(0, 7).map((r) => r.split(",").slice(0, 6));
    return (
      <div className="card-csv">
        <table><tbody>
          {rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}</tr>
          ))}
        </tbody></table>
      </div>
    );
  }
  if (kind === "email" || kind === "phone") {
    return (
      <div className="card-contact">
        <div className="card-contact-glyph">{kind === "email" ? <MailGlyph /> : <PhoneGlyph />}</div>
        <div className="card-contact-value">{entry.text.trim()}</div>
        <div className="card-contact-sub">{kind === "email" ? "Email address" : "Phone number"}</div>
      </div>
    );
  }
  if (kind === "path") {
    const p = entry.text.trim();
    const name = p.split(/[\\/]/).filter(Boolean).pop() || p;
    return (
      <div className="card-path">
        <div className="card-path-glyph"><FolderGlyph /></div>
        <div className="card-path-name">{name}</div>
        <div className="card-path-full">{p}</div>
      </div>
    );
  }
  if (kind === "file") {
    const files = entry.files ?? [];
    const first = files[0] ?? entry.text;
    const base = first.split(/[\\/]/).filter(Boolean).pop() || first;
    const ext = base.includes(".") ? base.split(".").pop()!.slice(0, 5).toUpperCase() : "FILE";
    return (
      <div className="card-file">
        <div className="card-file-glyph"><FileGlyph /><span className="card-file-ext">{ext}</span></div>
        <div className="card-file-name">{base}</div>
        <div className="card-file-sub">
          {files.length > 1 ? `+${files.length - 1} more file${files.length - 1 > 1 ? "s" : ""}` : "File"}
        </div>
      </div>
    );
  }
  if (kind === "link") {
    const u = entry.text.trim(); const d = domainOf(u);
    return (
      <div className="card-link">
        <img className="card-link-fav" src={`https://www.google.com/s2/favicons?domain=${d}&sz=64`} alt=""
          draggable={false} onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
        <div className="card-link-domain">{d}</div>
        <div className="card-link-url">{u}</div>
      </div>
    );
  }
  return <p className="card-textbody">{entry.text}</p>;
}

// ── Color card (full-bleed swatch + copyable formats) ───────────────────────────

export const ColorCard = memo(function ColorCard({
  entry, onPin, onDelete, notify, onContextMenu,
}: {
  entry: ClipboardEntry;
  onPin: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  notify: (m: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: ClipboardEntry) => void;
}) {
  const raw = entry.text.trim();
  const rgb = parseColor(raw);
  const formats = rgb ? colorFormats(rgb) : [{ label: "VALUE", value: raw }];
  const lum = rgb ? 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b : 0;
  const onLight = lum > 150;

  const paste = () => invoke("paste_clip", { id: entry.id });
  const copyFmt = (e: React.MouseEvent, v: string) => { e.stopPropagation(); invoke("copy_text", { text: v }); notify(`Copied  ${v}`); };

  return (
    <div className={`card kind-color is-color${onLight ? " on-light" : ""}${entry.pinned ? " is-pinned" : ""}`}
      style={{ aspectRatio: "1" }} onClick={paste} onContextMenu={(e) => onContextMenu(e, entry)}
      onMouseMove={handleTiltMove} onMouseEnter={handleCardEnter}
      onMouseLeave={handleTiltLeave} onAnimationEnd={handleGlintEnd}>
      <div className="card-clip">
        <div className="card-colorbg" style={{ background: raw }} />
        <div className="card-color-top">
          <div className="card-header-main">
            <span className="card-label">Color</span>
            <span className="card-time">{timeAgo(entry.timestamp)}</span>
          </div>
          <div className="card-actions">
            <PinButton pinned={entry.pinned} onPin={() => onPin(entry.id)} />
            <DeleteButton onDelete={(e) => onDelete(entry.id, e)} />
          </div>
        </div>
        <div className="card-color-formats">
          {formats.map((f) => (
            <button key={f.label} className="color-fmt" onClick={(e) => copyFmt(e, f.value)}>
              <span className="fmt-label">{f.label}</span>
              <span className="fmt-value">{f.value}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
});

// ── Unified card ───────────────────────────────────────────────────────────────

export const Card = memo(function Card({
  entry, onPin, onDelete, onRename, onContextMenu,
}: {
  entry: ClipboardEntry;
  onPin: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, name: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: ClipboardEntry) => void;
}) {
  const kind = effectiveKind(entry);
  const url = entry.text.trim();
  const yt = kind === "link" ? youtubeId(url) : null;

  const [ytMeta, setYtMeta] = useState<LinkMeta | null>(() => (yt ? loadLinkMeta(url) : null));
  const [headerColor, setHeaderColor] = useState<string>(() => {
    if (entry.process_icon) { const c = colorCache.get(entry.process_icon); if (c) return c; }
    return entry.process_icon ? processColor(entry.process) : KIND_FALLBACK_COLOR[kind];
  });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(entry.name ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!entry.process_icon) return;
    dominantColor(entry.process_icon).then((c) => { if (c) setHeaderColor(c); });
  }, [entry.process_icon]);

  useEffect(() => {
    if (!yt || ytMeta?.title) return;
    let alive = true;
    fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!alive || !j) return;
        const m: LinkMeta = { title: j.title, thumb: j.thumbnail_url, author: j.author_name };
        saveLinkMeta(url, m); setYtMeta(m);
      })
      .catch(() => { /* offline */ });
    return () => { alive = false; };
  }, [url, yt, ytMeta]);

  const mediaSrc = kind === "image"
    ? entry.image_data!
    : (kind === "file" && entry.image_data ? entry.image_data
    : (yt ? (ytMeta?.thumb || `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`) : null));
  const isMedia = !!mediaSrc;

  const arStyle: React.CSSProperties = {};
  if ((kind === "image" || kind === "file") && entry.img_w && entry.img_h) {
    arStyle.aspectRatio = `${Math.min(Math.max(entry.img_w / entry.img_h, 0.66), 21 / 9)}`;
  } else if (yt) {
    arStyle.aspectRatio = `${16 / 9}`;
  }

  const openable = kind === "link" || kind === "path" || kind === "email" || kind === "phone" || kind === "file";
  const openTarget = kind === "email" ? `mailto:${url}`
    : kind === "phone" ? `tel:${url.replace(/[\s()-]/g, "")}`
    : kind === "file" ? (entry.files?.[0] ?? url) : url;
  const openExternal = () => { invoke("open_external", { target: openTarget }); invoke("hide_window"); };
  const onCardClick = (e: React.MouseEvent) => {
    if (e.altKey && openable) { openExternal(); return; }
    invoke("paste_clip", { id: entry.id });
  };
  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation(); setEditing(true); setTimeout(() => inputRef.current?.select(), 0);
  };
  const commit = () => { setEditing(false); onRename(entry.id, name); };
  const cancel = () => { setName(entry.name ?? ""); setEditing(false); };

  const codeInfo = useMemo(() => cachedCodeInfoFor(kind, entry.text), [kind, entry.text]);

  const favicon = kind === "link" ? `https://www.google.com/s2/favicons?domain=${domainOf(url)}&sz=64` : null;
  // Code cards show the detected language (Verse, TypeScript, …) as the label.
  const codeLabel = kind === "code" && codeInfo?.language ? langDisplayName(codeInfo.language) : null;
  const baseLabel = codeLabel ?? (kind === "link" && isMedia ? "Rich Link" : KIND_LABEL[kind]);
  const label = name.trim() || baseLabel;
  const footerMeta = isMedia
    ? (kind === "image" ? metaText("image", entry)
      : kind === "file" ? metaText("file", entry)
      : (ytMeta?.title || domainOf(url)))
    : metaText(kind, entry);

  return (
    <div
      className={`card kind-${kind}${isMedia ? " is-media" : ""}${entry.pinned ? " is-pinned" : ""}`}
      style={{ ...arStyle, "--header-color": headerColor } as React.CSSProperties}
      onClick={onCardClick}
      onContextMenu={(e) => onContextMenu(e, entry)}
      onMouseMove={handleTiltMove}
      onMouseEnter={handleCardEnter}
      onMouseLeave={handleTiltLeave}
      onAnimationEnd={handleGlintEnd}
    >
      <div className="card-clip">
        {isMedia && <div className="card-media"><img className="card-media-img" src={mediaSrc} alt="" draggable={false} /></div>}
        {isMedia && yt && <div className="card-play"><PlayBadge /></div>}

        <div className={`card-header${isMedia ? " overlay" : ""}`}>
          <div className="card-header-main" onClick={(e) => e.stopPropagation()} onDoubleClick={startEdit}>
            {editing ? (
              <input
                ref={inputRef}
                className="card-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={commit}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => { if (e.key === "Enter") commit(); else if (e.key === "Escape") cancel(); }}
                placeholder={KIND_LABEL[kind]}
              />
            ) : (
              <span className="card-label">{label}</span>
            )}
            <span className="card-time">{timeAgo(entry.timestamp)}</span>
          </div>
          {favicon ? (
            <img className="card-icon favicon" src={favicon} alt="" draggable={false}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
          ) : entry.process_icon ? (
            <img className="card-icon" src={entry.process_icon} alt="" draggable={false} />
          ) : (
            <span className="card-icon-fallback">{entry.process.charAt(0).toUpperCase()}</span>
          )}
        </div>

        {!isMedia && <div className="card-body"><CardBody kind={kind} entry={entry} codeHtml={codeInfo?.html ?? null} /></div>}

        <div className={`card-footer${isMedia ? " overlay" : ""}`}>
          <span className="card-meta">{footerMeta}</span>
          <div className="card-actions">
            {openable && (
              <button className="action-btn open-btn" onClick={(e) => { e.stopPropagation(); openExternal(); }} aria-label="Open">
                <ExternalIcon />
              </button>
            )}
            {kind === "image" && (
              <button className="action-btn open-btn"
                onClick={(e) => { e.stopPropagation(); invoke("open_image", { id: entry.id }); invoke("hide_window"); }}
                aria-label="Open image">
                <ExternalIcon />
              </button>
            )}
            {kind === "file" && (
              <button className="action-btn open-btn"
                onClick={(e) => { e.stopPropagation(); invoke("reveal_in_explorer", { path: entry.files?.[0] ?? entry.text }); }}
                aria-label="Open file location">
                <RevealIcon />
              </button>
            )}
            {kind === "image" && (
              <button className="action-btn open-btn"
                onClick={(e) => { e.stopPropagation(); invoke("reveal_image", { id: entry.id }); }}
                aria-label="Show in folder">
                <RevealIcon />
              </button>
            )}
            <PinButton pinned={entry.pinned} onPin={() => onPin(entry.id)} />
            <DeleteButton onDelete={(e) => onDelete(entry.id, e)} />
          </div>
        </div>
      </div>
    </div>
  );
});
