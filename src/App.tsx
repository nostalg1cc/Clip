import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AmbientBackdrop } from "./components/AmbientBackdrop";
import { ContextMenu, type CtxMenuState } from "./components/ContextMenu";
import { DownloaderView } from "./components/DownloaderView";
import { EmojiView, loadRecentEmojis } from "./components/EmojiView";
import { SettingsView } from "./components/SettingsView";
import { TopBar } from "./components/TopBar";
import { VirtualClipStrip } from "./components/VirtualClipStrip";
import { useDragScroll } from "./hooks/useDragScroll";
import {
  GROUP_LABEL,
  GROUP_ORDER,
  effectiveKind,
  filterGroup,
  type ClipboardEntry,
  type Filter,
  type Group,
} from "./clipUtils";
import "./App.css";

type BackdropMode = "acrylic" | "mica" | "adaptive";
type AppSettings = { backdrop: BackdropMode };
// ── App ────────────────────────────────────────────────────────────────────────

function App() {
  const [entries, setEntries] = useState<ClipboardEntry[]>([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [, setTick] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const displayedRef = useRef<ClipboardEntry[]>([]);
  const [clipViewport, setClipViewport] = useState({ left: 0, width: 900, height: 320 });
  const [backdropMode, setBackdropMode] = useState<BackdropMode>("acrylic");
  const toastTimer = useRef<number | undefined>(undefined);
  const fadeRaf = useRef<number | undefined>(undefined);
  const clipViewportRaf = useRef<number | undefined>(undefined);
  const drag = useDragScroll(scrollRef);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1300);
  }, []);

  const updateFadesNow = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    el.classList.toggle("can-left", el.scrollLeft > 4);
    el.classList.toggle("can-right", el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  const scheduleUpdateFades = useCallback(() => {
    if (fadeRaf.current !== undefined) return;
    fadeRaf.current = window.requestAnimationFrame(() => {
      fadeRaf.current = undefined;
      updateFadesNow();
    });
  }, [updateFadesNow]);

  const updateClipViewportNow = useCallback(() => {
    const el = scrollRef.current; if (!el) return;
    const style = window.getComputedStyle(el);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    setClipViewport({
      left: el.scrollLeft,
      width: el.clientWidth,
      height: Math.max(80, el.clientHeight - padTop - padBottom),
    });
  }, []);

  const scheduleUpdateClipViewport = useCallback(() => {
    if (clipViewportRaf.current !== undefined) return;
    clipViewportRaf.current = window.requestAnimationFrame(() => {
      clipViewportRaf.current = undefined;
      updateClipViewportNow();
    });
  }, [updateClipViewportNow]);

  useEffect(() => () => {
    if (fadeRaf.current !== undefined) window.cancelAnimationFrame(fadeRaf.current);
    if (clipViewportRaf.current !== undefined) window.cancelAnimationFrame(clipViewportRaf.current);
  }, []);

  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", prevent);
    document.addEventListener("dragstart", prevent);
    document.addEventListener("dragover", prevent);
    document.addEventListener("drop", prevent);
    return () => {
      document.removeEventListener("contextmenu", prevent);
      document.removeEventListener("dragstart", prevent);
      document.removeEventListener("dragover", prevent);
      document.removeEventListener("drop", prevent);
    };
  }, []);

  useEffect(() => {
    invoke<ClipboardEntry[]>("get_history").then(setEntries).catch(() => {});
  }, []);

  useEffect(() => {
    invoke<AppSettings>("get_app_settings")
      .then((settings) => setBackdropMode(settings.backdrop))
      .catch(() => {});
    const unlistenBackdrop = listen<BackdropMode>("backdrop-changed", (event) => {
      if (event.payload === "acrylic" || event.payload === "mica" || event.payload === "adaptive") {
        setBackdropMode(event.payload);
      }
    });
    return () => {
      unlistenBackdrop.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlistenNew = listen<ClipboardEntry>("clipboard-new", (e) => {
      setEntries((prev) => [e.payload, ...prev.filter((p) => p.id !== e.payload.id)]);
    });
    const unlistenUpd = listen<ClipboardEntry[]>("clips-updated", (e) => setEntries(e.payload));
    const timer = setInterval(() => setTick((t) => t + 1), 15_000);
    const onKey = (e: KeyboardEvent) => {
      const inInput = (e.target as HTMLElement)?.tagName === "INPUT";
      if (ctxMenu) {
        if (e.key === "Escape") setCtxMenu(null);
        return;
      }
      if (e.key === "Escape") {
        if (search) setSearch("");
        else if (filter !== "all") setFilter("all");
        else invoke("hide_window");
        return;
      }
      if (inInput) return;
      if (filter !== "emoji" && /^[1-9]$/.test(e.key)) {
        const target = displayedRef.current[parseInt(e.key, 10) - 1];
        if (target) invoke("paste_clip", { id: target.id });
        return;
      }
      // Type anywhere to search — first printable char focuses + fills the box
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        setSearch((s) => s + e.key);
        (document.querySelector(".fluent-search input") as HTMLInputElement | null)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unlistenNew.then((fn) => fn());
      unlistenUpd.then((fn) => fn());
      clearInterval(timer);
      window.removeEventListener("keydown", onKey);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, filter, ctxMenu]);

  // If the clip the context menu points at disappears (expired/deleted from
  // elsewhere), close the menu instead of leaving it pointing at a stale id.
  useEffect(() => {
    if (ctxMenu && !entries.some((e) => e.id === ctxMenu.entry.id)) setCtxMenu(null);
  }, [entries, ctxMenu]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    scheduleUpdateFades();
    scheduleUpdateClipViewport();
  }, [filter, search, scheduleUpdateFades, scheduleUpdateClipViewport]);


  useEffect(() => {
    const el = scrollRef.current;
    const onResize = () => scheduleUpdateClipViewport();
    const resizeObserver = el && "ResizeObserver" in window ? new ResizeObserver(onResize) : null;
    if (el) resizeObserver?.observe(el);
    window.addEventListener("resize", onResize);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onResize);
    };
  }, [scheduleUpdateClipViewport]);
  const handlePin = useCallback(async (id: string) => {
    const newPinned = await invoke<boolean>("toggle_pin", { id });
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, pinned: newPinned } : e)));
  }, []);
  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await invoke("delete_clip", { id });
    setEntries((prev) => prev.filter((entry) => entry.id !== id));
  }, []);
  const handleRename = useCallback(async (id: string, name: string) => {
    await invoke("rename_clip", { id, name });
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, name: name.trim() || null } : e)));
  }, []);
  const handleCopy = useCallback((id: string) => { invoke("copy_clip", { id }); notify("Copied to clipboard"); }, [notify]);
  const handleClear = useCallback(async () => {
    await invoke("clear_history");
    setEntries((prev) => prev.filter((e) => e.pinned));
    notify("Cleared unpinned clips");
  }, [notify]);
  const openContextMenu = useCallback((e: React.MouseEvent, entry: ClipboardEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);
  const groupCounts = useMemo(() => {
    const c: Record<Group, number> & { pinned: number } = { text: 0, code: 0, link: 0, image: 0, file: 0, color: 0, pinned: 0 };
    for (const e of entries) { c[filterGroup(effectiveKind(e))]++; if (e.pinned) c.pinned++; }
    return c;
  }, [entries]);

  const tabs = useMemo<{ key: Filter; label: string; count?: number }[]>(() => {
    const out: { key: Filter; label: string; count?: number }[] = [{ key: "all", label: "All", count: entries.length }];
    if (groupCounts.pinned) out.push({ key: "pinned", label: "Pinned", count: groupCounts.pinned });
    for (const g of GROUP_ORDER) if (groupCounts[g]) out.push({ key: g, label: GROUP_LABEL[g], count: groupCounts[g] });
    out.push({ key: "emoji", label: "Emoji" });
    out.push({ key: "downloader", label: "Downloader" });
    out.push({ key: "settings", label: "Settings" });
    return out;
  }, [entries.length, groupCounts]);

  const displayed = useMemo(() => {
    let list = entries;
    if (filter === "pinned") list = list.filter((e) => e.pinned);
    else if (filter !== "all" && filter !== "emoji" && filter !== "settings" && filter !== "downloader") list = list.filter((e) => filterGroup(effectiveKind(e)) === filter);
    if (search.trim()) {
      const sq = search.toLowerCase();
      list = list.filter((e) =>
        e.text.toLowerCase().includes(sq) || e.process.toLowerCase().includes(sq) || (e.name ?? "").toLowerCase().includes(sq));
    }
    return [...list.filter((e) => e.pinned), ...list.filter((e) => !e.pinned)];
  }, [entries, search, filter]);
  displayedRef.current = displayed;

  useLayoutEffect(() => { updateClipViewportNow(); }, [displayed.length, filter, search, updateClipViewportNow]);
  useEffect(() => { scheduleUpdateFades(); scheduleUpdateClipViewport(); }, [displayed.length, scheduleUpdateFades, scheduleUpdateClipViewport]);

  const emojiIcon = loadRecentEmojis()[0] || "\u{1F600}";
  const emptyMsg = search
    ? `No results for "${search}"`
    : filter === "pinned" ? "No pinned clips yet"
    : filter !== "all" && filter !== "settings" ? `No ${String(filter)} clips yet`
    : "Copy something to get started";

  return (
    <div className="app">
      <AmbientBackdrop active={backdropMode === "adaptive"} entries={displayed} viewport={clipViewport} />
      <TopBar
        search={search} onSearch={setSearch}
        filter={filter} onFilter={setFilter}
        total={entries.length} tabs={tabs} onClear={handleClear} emojiIcon={emojiIcon}
      />
      <div
        className={`cards-row${filter === "emoji" ? " is-emoji" : ""}${filter === "downloader" ? " is-downloader" : ""}${filter === "settings" ? " is-settings" : ""}`}
        ref={scrollRef}
        onScroll={() => { updateFadesNow(); updateClipViewportNow(); }}
        {...(filter === "emoji" || filter === "downloader" || filter === "settings" ? {} : drag)}
      >
        {filter === "downloader" ? (
          <DownloaderView
            downloads={entries.filter((e) => e.process === "Downloader")}
            notify={notify}
            onPin={handlePin} onDelete={handleDelete} onRename={handleRename} onContextMenu={openContextMenu}
          />
        ) : filter === "emoji" ? (
          <EmojiView search={search} notify={notify} />
        ) : filter === "settings" ? (
          <SettingsView notify={notify} />
        ) : displayed.length === 0 ? (
          <div className="empty-state">{emptyMsg}</div>
        ) : (
          <VirtualClipStrip
            entries={displayed}
            viewport={clipViewport}
            notify={notify}
            onPin={handlePin}
            onDelete={handleDelete}
            onRename={handleRename}
            onContextMenu={openContextMenu}
          />
        )}
      </div>
      {toast && <div className="toast">{toast}</div>}
      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onCopy={handleCopy}
          onPin={handlePin}
          onDelete={handleDelete}
          notify={notify}
        />
      )}
    </div>
  );
}

export default App;
