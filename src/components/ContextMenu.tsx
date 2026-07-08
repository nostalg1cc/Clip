import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type React from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ClipboardEntry } from "../clipUtils";
// ── Context menu ─────────────────────────────────────────────────────────────

export interface CtxMenuState { x: number; y: number; entry: ClipboardEntry }
interface LocalSendPeer { fingerprint: string; alias: string; ip: string; port: number; deviceType?: string }
interface LocalSendHistoryEntry { ip: string; port: number; alias?: string; lastUsedMs: number }

export function ContextMenu({
  state, onClose, onCopy, onPin, onDelete, notify,
}: {
  state: CtxMenuState;
  onClose: () => void;
  onCopy: (id: string) => void;
  onPin: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  notify: (m: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y, ready: false });
  const [view, setView] = useState<"main" | "localsend">("main");
  const [peers, setPeers] = useState<LocalSendPeer[]>([]);
  const [history, setHistory] = useState<LocalSendHistoryEntry[]>([]);
  const [manualIp, setManualIp] = useState("");
  const [sending, setSending] = useState(false);

  // Measure after mount and clamp to the window so the menu never opens
  // off-screen (the bar is full-width but only ~400px tall). Re-clamps when
  // switching views since the LocalSend sub-view is a different size.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    const x = Math.max(6, Math.min(state.x, window.innerWidth - w - 6));
    const y = Math.max(6, Math.min(state.y, window.innerHeight - h - 6));
    setPos({ x, y, ready: true });
  }, [state.x, state.y, view]);

  // Poll for nearby devices while the LocalSend sub-view is open. Also load
  // recently-used devices once — multicast discovery is finicky (VPNs, VMs,
  // multiple network adapters all commonly break it silently), so a device
  // you've successfully sent to before is a reliable one-click fallback.
  useEffect(() => {
    if (view !== "localsend") return;
    invoke<LocalSendHistoryEntry[]>("localsend_get_history").then(setHistory).catch(() => {});
    const load = () => invoke<LocalSendPeer[]>("localsend_list_peers").then(setPeers).catch(() => {});
    load();
    const t = window.setInterval(load, 2000);
    return () => window.clearInterval(t);
  }, [view]);

  // Send commands return immediately (the actual network I/O happens on a
  // background thread on the Rust side, so a slow/unreachable device can't
  // freeze the app) — the real outcome arrives via this event.
  useEffect(() => {
    const un = listen<{ ok: boolean; message?: string }>("localsend-send-result", (e) => {
      notify(e.payload.ok ? "Sent" : (e.payload.message ?? "Couldn't send"));
      setSending(false);
      onClose();
    });
    return () => { un.then((f) => f()); };
  }, [notify, onClose]);

  const { entry } = state;

  const send = (target: { fingerprint: string } | { ip: string; port?: number }) => {
    setSending(true);
    if ("fingerprint" in target) invoke("localsend_send", { id: entry.id, fingerprint: target.fingerprint });
    else invoke("localsend_send_to_ip", { id: entry.id, ip: target.ip, port: target.port ?? 53317 });
  };

  const item = (label: string, action: (e: React.MouseEvent) => void, opts?: { danger?: boolean; disabled?: boolean }) => (
    <button
      className={`ctx-item${opts?.danger ? " danger" : ""}`}
      disabled={opts?.disabled}
      onClick={(e) => { e.stopPropagation(); action(e); }}
    >
      {label}
    </button>
  );

  return (
    <>
      {/* Full-screen catcher: first click/right-click anywhere else just
          dismisses the menu, same as a native context menu. */}
      <div className="ctx-overlay" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="ctx-menu"
        ref={menuRef}
        style={{ left: pos.x, top: pos.y, visibility: pos.ready ? "visible" : "hidden" }}
        onClick={(e) => e.stopPropagation()}
      >
        {view === "main" ? (
          <>
            {item("Copy", () => { onCopy(entry.id); onClose(); })}
            {item(entry.pinned ? "Unpin" : "Pin", () => { onPin(entry.id); onClose(); })}
            {item("Send via LocalSend  ›", () => setView("localsend"))}
            <div className="ctx-sep" />
            {item("Delete", (e) => onDelete(entry.id, e), { danger: true })}
          </>
        ) : (
          <>
            {item("‹  Back", () => setView("main"))}
            <div className="ctx-sep" />
            <div className="ctx-heading">Nearby devices</div>
            {peers.length === 0 && <div className="ctx-empty">{sending ? "Sending…" : "Searching…"}</div>}
            {peers.map((p) => (
              <button
                key={p.fingerprint} className="ctx-item" disabled={sending}
                onClick={(e) => { e.stopPropagation(); send({ fingerprint: p.fingerprint }); }}
              >
                {p.alias} <span className="ctx-sub">{p.ip}</span>
              </button>
            ))}
            {history.filter((h) => !peers.some((p) => p.ip === h.ip)).length > 0 && (
              <>
                <div className="ctx-heading">Recent</div>
                {history.filter((h) => !peers.some((p) => p.ip === h.ip)).map((h) => (
                  <button
                    key={h.ip} className="ctx-item" disabled={sending}
                    onClick={(e) => { e.stopPropagation(); send({ ip: h.ip, port: h.port }); }}
                  >
                    {h.alias ?? h.ip} <span className="ctx-sub">{h.ip}</span>
                  </button>
                ))}
              </>
            )}
            <div className="ctx-sep" />
            <input
              className="ctx-ip-input" placeholder="Or enter an IP…" value={manualIp}
              disabled={sending}
              onMouseDown={() => { invoke("focus_search").catch(() => {}); }}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setManualIp(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter" && manualIp.trim()) send({ ip: manualIp.trim() });
              }}
            />
          </>
        )}
      </div>
    </>
  );
}
