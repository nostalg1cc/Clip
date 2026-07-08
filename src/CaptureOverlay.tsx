import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type Rect = { x: number; y: number; w: number; h: number };

const BLUE = "50, 140, 255";
const YELLOW = "255, 195, 0";

export default function CaptureOverlay() {
  const [frame, setFrame] = useState<string | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [textMode, setTextMode] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    // This window is created hidden at app startup and reused for every
    // capture — each hotkey press emits a freshly grabbed frame (grabbed
    // before this window ever touches the screen, so hardware-composited
    // content like video captures correctly instead of reading back black).
    const reset = () => {
      draggingRef.current = false;
      startRef.current = null;
      setRect(null);
      setTextMode(false);
      setFrame(null);
    };
    const unReset = listen("capture-reset", reset);
    const un = listen<string>("capture-frame", (e) => {
      reset();
      setFrame(e.payload);
      window.setTimeout(() => invoke("capture_show_ready").catch(() => {}), 0);
    });
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") invoke("capture_cancel").catch(() => {});
      else if (ev.key === "t" || ev.key === "T") setTextMode((v) => !v);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      unReset.then((f) => f());
      un.then((f) => f());
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent) => {
    draggingRef.current = true;
    startRef.current = { x: e.clientX, y: e.clientY };
    setRect({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!draggingRef.current || !startRef.current) return;
    const s = startRef.current;
    setRect({
      x: Math.min(s.x, e.clientX),
      y: Math.min(s.y, e.clientY),
      w: Math.abs(e.clientX - s.x),
      h: Math.abs(e.clientY - s.y),
    });
  };

  const onMouseUp = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    startRef.current = null;
    if (!rect || rect.w < 4 || rect.h < 4) {
      invoke("capture_cancel").catch(() => {});
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    invoke("capture_finish_selection", {
      x: Math.round(rect.x * dpr),
      y: Math.round(rect.y * dpr),
      width: Math.round(rect.w * dpr),
      height: Math.round(rect.h * dpr),
      mode: textMode ? "text" : "image",
    }).catch(() => {});
  };

  const rgb = textMode ? YELLOW : BLUE;
  // Scales with whatever monitor this landed on instead of a fixed px value,
  // so it reads the same on a laptop panel or a 4K/ultrawide.
  const minDim = Math.min(window.innerWidth, window.innerHeight);
  const glowSpread = Math.max(24, minDim * 0.025);
  const glowBlur = glowSpread * 3;

  return (
    <div
      style={{ position: "fixed", inset: 0, cursor: "crosshair", overflow: "hidden", userSelect: "none", background: "#000" }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
    >
      {frame && (
        <img
          src={frame}
          draggable={false}
          alt=""
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
        />
      )}
      <style>{`
        @keyframes clip-capture-glow-pulse {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
      `}</style>
      <div
        // key forces a remount (animation restart) on mode change, so the
        // color swap reads as an obvious pulse/blip instead of a quiet
        // style update that's easy to miss against a busy screenshot.
        key={textMode ? "text" : "image"}
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          boxShadow: `inset 0 0 ${glowBlur}px ${glowSpread}px rgba(${rgb}, 0.4)`,
          animation: "clip-capture-glow-pulse 2s ease-in-out infinite",
        }}
      />
      {rect && (
        <div
          style={{
            position: "absolute",
            left: rect.x,
            top: rect.y,
            width: rect.w,
            height: rect.h,
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.35)",
            outline: `1px solid rgba(${rgb}, 0.95)`,
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: rect.y > 30 ? -22 : 4,
              fontSize: 12,
              fontFamily: "Segoe UI, sans-serif",
              color: "#fff",
              background: "rgba(0, 0, 0, 0.65)",
              padding: "2px 6px",
              borderRadius: 4,
              whiteSpace: "nowrap",
            }}
          >
            {Math.round(rect.w)} × {Math.round(rect.h)}{textMode ? " · Text" : ""}
          </div>
        </div>
      )}
    </div>
  );
}
