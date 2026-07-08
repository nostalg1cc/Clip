import { useRef } from "react";
import type React from "react";
// ── Drag-to-scroll with inertia ─────────────────────────────────────────────────

export function useDragScroll(ref: React.RefObject<HTMLDivElement | null>) {
  const st = useRef({ down: false, moved: false, startX: 0, startScroll: 0, lastX: 0, lastT: 0, vel: 0, raf: 0 });
  const dragged = useRef(false);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current; if (!el || e.button !== 0) return;
    const s = st.current;
    cancelAnimationFrame(s.raf);
    s.down = true; s.moved = false;
    s.startX = e.clientX; s.startScroll = el.scrollLeft;
    s.lastX = e.clientX; s.lastT = performance.now(); s.vel = 0;
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = ref.current; const s = st.current;
    if (!s.down || !el) return;
    const dx = e.clientX - s.startX;
    if (!s.moved && Math.abs(dx) > 6) {
      s.moved = true; dragged.current = true; el.classList.add("dragging");
      try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    }
    if (s.moved) {
      el.scrollLeft = s.startScroll - dx;
      const now = performance.now(); const dt = now - s.lastT;
      if (dt > 0) { s.vel = (e.clientX - s.lastX) / dt; s.lastX = e.clientX; s.lastT = now; }
    }
  };
  const onPointerUp = () => {
    const el = ref.current; const s = st.current;
    if (!s.down) return;
    s.down = false;
    if (s.moved && el) {
      el.classList.remove("dragging");
      let v = s.vel * 16;
      const step = () => {
        v *= 0.92;
        if (Math.abs(v) < 0.4 || !ref.current) return;
        ref.current.scrollLeft -= v;
        s.raf = requestAnimationFrame(step);
      };
      cancelAnimationFrame(s.raf); s.raf = requestAnimationFrame(step);
      window.setTimeout(() => { dragged.current = false; }, 50);
    }
    s.moved = false;
  };
  const onClickCapture = (e: React.MouseEvent) => {
    if (dragged.current) { e.stopPropagation(); dragged.current = false; }
  };
  return { onPointerDown, onPointerMove, onPointerUp, onClickCapture };
}
