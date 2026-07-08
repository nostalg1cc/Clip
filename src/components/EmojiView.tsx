import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { invoke } from "@tauri-apps/api/core";
import { EMOJI_CATEGORIES, ALL_EMOJI_ITEMS, SKIN_TONES, applyTone } from "../emojis";
import { useDragScroll } from "../hooks/useDragScroll";

const ROWS = 5;
const CELL_STEP = 50;
const GROUP_GAP = 22;
const BUFFER_PX = 500;
const HAND_EMOJI = "\u270B";

type Viewport = { left: number; width: number };

type GroupLayout = {
  name: string;
  icon: string;
  items: string[];
  left: number;
  width: number;
};

export function loadRecentEmojis(): string[] {
  try { return JSON.parse(localStorage.getItem("emoji-recents") || "[]"); } catch { return []; }
}

function pushRecentEmoji(emoji: string) {
  const cur = loadRecentEmojis().filter((x) => x !== emoji);
  cur.unshift(emoji);
  localStorage.setItem("emoji-recents", JSON.stringify(cur.slice(0, 20)));
}

function groupWidth(count: number): number {
  return Math.max(CELL_STEP, Math.ceil(count / ROWS) * CELL_STEP);
}

function measureViewport(el: HTMLDivElement | null): Viewport {
  return { left: el?.scrollLeft ?? 0, width: el?.clientWidth ?? 900 };
}

export function EmojiView({ search, notify }: { search: string; notify: (msg: string) => void }) {
  const [recent, setRecent] = useState<string[]>(loadRecentEmojis);
  const [tone, setTone] = useState<string>(() => localStorage.getItem("emoji-tone") || "");
  const [viewport, setViewport] = useState<Viewport>({ left: 0, width: 900 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | undefined>(undefined);
  const drag = useDragScroll(scrollRef);

  const updateViewport = useCallback(() => {
    if (rafRef.current !== undefined) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = undefined;
      setViewport(measureViewport(scrollRef.current));
    });
  }, []);

  useEffect(() => {
    updateViewport();
    const onResize = () => updateViewport();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (rafRef.current !== undefined) window.cancelAnimationFrame(rafRef.current);
    };
  }, [updateViewport]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    setViewport(measureViewport(scrollRef.current));
  }, [search]);

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
    if (scrollRef.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      scrollRef.current.scrollLeft += e.deltaY;
      updateViewport();
    }
  };

  const q = search.trim().toLowerCase();
  const tokens = q ? q.split(/\s+/) : [];
  const results = useMemo(
    () => q ? ALL_EMOJI_ITEMS.filter(([, k]) => tokens.every((t) => k.includes(t))).map(([e]) => e) : null,
    [q, tokens.join("\u0000")],
  );

  const groups = useMemo<GroupLayout[]>(() => {
    let left = 0;
    return EMOJI_CATEGORIES.map((cat) => {
      const items = cat.items.map(([e]) => e);
      const width = groupWidth(items.length);
      const group = { name: cat.name, icon: cat.icon, items, left, width };
      left += width + GROUP_GAP;
      return group;
    });
  }, []);

  const totalGroupWidth = groups.length ? groups[groups.length - 1].left + groups[groups.length - 1].width : 0;
  const visibleLeft = Math.max(0, viewport.left - BUFFER_PX);
  const visibleRight = viewport.left + viewport.width + BUFFER_PX;
  const visibleGroups = groups.filter((group) => group.left + group.width >= visibleLeft && group.left <= visibleRight);

  const searchWidth = groupWidth(results?.length ?? 0);
  const startColumn = Math.max(0, Math.floor(visibleLeft / CELL_STEP));
  const endColumn = Math.ceil(visibleRight / CELL_STEP);
  const searchStart = startColumn * ROWS;
  const searchEnd = Math.min(results?.length ?? 0, Math.max(searchStart, endColumn * ROWS));
  const visibleResults = results?.slice(searchStart, searchEnd) ?? [];

  const cell = (em: string, key: string | number) => <span key={key} className="emoji-btn" data-emoji={em}>{em}</span>;

  return (
    <div className="emoji-view" onClick={onPaste} onContextMenu={onCopyCtx}>
      {!results && (
        <>
          <div className="emoji-fixed">
            <div className="emoji-tones">
              {SKIN_TONES.map(({ tone: t, label }) => (
                <button key={t || "default"} className={`tone-btn${tone === t ? " active" : ""}`} aria-label={label}
                  onClick={(e) => { e.stopPropagation(); setSelectedTone(t); }}>
                  {applyTone(HAND_EMOJI, t)}
                </button>
              ))}
            </div>
            <div className="emoji-group-title">Recent</div>
            {recent.length ? (
              <div className="emoji-grid">{recent.map((e, i) => cell(e, i))}</div>
            ) : (
              <div className="emoji-empty">Emoji you use<br />show up here</div>
            )}
          </div>
          <div className="emoji-divider" />
        </>
      )}
      <div className="emoji-scroll is-virtual" ref={scrollRef} onWheel={onWheel} onScroll={updateViewport} {...drag}>
        {results ? (
          <div className="emoji-virtual-track" style={{ width: searchWidth }}>
            <div className="emoji-group emoji-search-group" style={{ width: searchWidth }}>
              <div className="emoji-group-title">{results.length} result{results.length === 1 ? "" : "s"}</div>
              {results.length ? (
                <div className="emoji-grid-window">
                  <div className="emoji-grid" style={{ transform: `translateX(${startColumn * CELL_STEP}px)` }}>
                    {visibleResults.map((e, i) => cell(applyTone(e, tone), searchStart + i))}
                  </div>
                </div>
              ) : (
                <div className="emoji-empty">No emoji matches "{search}"</div>
              )}
            </div>
          </div>
        ) : (
          <div className="emoji-virtual-track" style={{ width: totalGroupWidth }}>
            {visibleGroups.map((cat) => (
              <div className="emoji-group" key={cat.name} style={{ left: cat.left, width: cat.width }}>
                <div className="emoji-group-title">{cat.icon} {cat.name}</div>
                <div className="emoji-grid">{cat.items.map((e, i) => cell(applyTone(e, tone), i))}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
