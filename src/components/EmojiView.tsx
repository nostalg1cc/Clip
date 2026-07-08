import { useRef, useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { EMOJI_CATEGORIES, ALL_EMOJI_ITEMS, SKIN_TONES, applyTone } from "../emojis";
import { useDragScroll } from "../hooks/useDragScroll";
// ── Emoji picker ───────────────────────────────────────────────────────────────

export function loadRecentEmojis(): string[] {
  try { return JSON.parse(localStorage.getItem("emoji-recents") || "[]"); } catch { return []; }
}
function pushRecentEmoji(emoji: string) {
  const cur = loadRecentEmojis().filter((x) => x !== emoji);
  cur.unshift(emoji);
  localStorage.setItem("emoji-recents", JSON.stringify(cur.slice(0, 20)));
}

export function EmojiView({ search, notify }: { search: string; notify: (msg: string) => void }) {
  const [recent, setRecent] = useState<string[]>(loadRecentEmojis);
  const [tone, setTone] = useState<string>(() => localStorage.getItem("emoji-tone") || "");
  const scrollRef = useRef<HTMLDivElement>(null);
  const drag = useDragScroll(scrollRef);

  const setSelectedTone = (t: string) => { setTone(t); localStorage.setItem("emoji-tone", t); };
  const used = (emoji: string) => { pushRecentEmoji(emoji); setRecent(loadRecentEmojis()); };
  const emojiAt = (e: React.MouseEvent): string | null => {
    const el = (e.target as HTMLElement).closest("[data-emoji]") as HTMLElement | null;
    return el?.dataset.emoji ?? null;
  };
  const onPaste = (e: React.MouseEvent) => {
    const em = emojiAt(e); if (!em) return;
    invoke("paste_text", { text: em }); used(em);
  };
  const onCopyCtx = (e: React.MouseEvent) => {
    const em = emojiAt(e); if (!em) return;
    e.preventDefault();
    invoke("copy_text", { text: em }); used(em); notify(`Copied  ${em}`);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (scrollRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) scrollRef.current.scrollLeft += e.deltaY;
  };

  const q = search.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/) : [];
  const results = q ? ALL_EMOJI_ITEMS.filter(([, k]) => tokens.every((t) => k.includes(t))).map(([e]) => e) : null;
  const cell = (em: string, key: number) => <span key={key} className="emoji-btn" data-emoji={em}>{em}</span>;
  // content-visibility per category (skips off-screen paint) with a matching
  // intrinsic width so there's no layout shift while scrolling.
  const groupStyle = (count: number): React.CSSProperties => ({
    contentVisibility: "auto",
    containIntrinsicSize: `${Math.ceil(count / 5) * 48}px 280px`,
  });

  return (
    <div className="emoji-view" onClick={onPaste} onContextMenu={onCopyCtx}>
      {!results && (
        <>
          <div className="emoji-fixed">
            <div className="emoji-tones">
              {SKIN_TONES.map(({ tone: t, label }) => (
                <button key={t || "default"} className={`tone-btn${tone === t ? " active" : ""}`} aria-label={label}
                  onClick={(e) => { e.stopPropagation(); setSelectedTone(t); }}>
                  {applyTone("✋", t)}
                </button>
              ))}
            </div>
            <div className="emoji-group-title">★ Recent</div>
            {recent.length ? (
              <div className="emoji-grid">{recent.map((e, i) => cell(e, i))}</div>
            ) : (
              <div className="emoji-empty">Emoji you use<br />show up here</div>
            )}
          </div>
          <div className="emoji-divider" />
        </>
      )}
      <div className="emoji-scroll" ref={scrollRef} onWheel={onWheel} {...drag}>
        {results ? (
          <div className="emoji-group">
            <div className="emoji-group-title">{results.length} result{results.length === 1 ? "" : "s"}</div>
            {results.length ? (
              <div className="emoji-grid">{results.map((e, i) => cell(applyTone(e, tone), i))}</div>
            ) : (
              <div className="emoji-empty">No emoji matches “{search}”</div>
            )}
          </div>
        ) : (
          EMOJI_CATEGORIES.map((cat) => (
            <div className="emoji-group" key={cat.name} style={groupStyle(cat.items.length)}>
              <div className="emoji-group-title">{cat.icon} {cat.name}</div>
              <div className="emoji-grid">{cat.items.map(([e], i) => cell(applyTone(e, tone), i))}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
