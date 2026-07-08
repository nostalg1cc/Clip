import { useMemo, type CSSProperties } from "react";
import {
  KIND_FALLBACK_COLOR,
  colorCache,
  effectiveKind,
  parseColor,
  processColor,
  type ClipboardEntry,
} from "../clipUtils";
import { buildClipLayout, clipCardHeight, visibleClipLayoutItems, type ClipViewport } from "./VirtualClipStrip";

function colorForEntry(entry: ClipboardEntry): string {
  const kind = effectiveKind(entry);
  if (kind === "color") {
    const rgb = parseColor(entry.text.trim());
    if (rgb) return `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
  }

  const cachedVisualColor = (entry.image_data && colorCache.get(entry.image_data))
    || (entry.process_icon && colorCache.get(entry.process_icon));
  if (cachedVisualColor) return cachedVisualColor;

  if (entry.process) return processColor(entry.process);
  return KIND_FALLBACK_COLOR[kind];
}

export function AmbientBackdrop({
  active,
  entries,
  viewport,
}: {
  active: boolean;
  entries: ClipboardEntry[];
  viewport: ClipViewport;
}) {
  const cardHeight = clipCardHeight(viewport);
  const { items, totalWidth } = useMemo(() => buildClipLayout(entries, cardHeight), [entries, cardHeight]);
  const visibleItems = visibleClipLayoutItems(items, viewport, 900).filter((item) => item.kind === "card" && item.entry);

  return (
    <div className={`ambient-backdrop${active ? " active" : ""}`} aria-hidden="true">
      <div
        className="ambient-backdrop-track"
        style={{ width: totalWidth, height: cardHeight, transform: `translate3d(${-viewport.left}px, 0, 0)` }}
      >
        {visibleItems.map((item) => {
          const color = colorForEntry(item.entry!);
          return (
            <div
              key={item.key}
              className="ambient-card-glow"
              style={{ left: item.left, width: item.width, "--ambient-color": color } as CSSProperties}
            />
          );
        })}
      </div>
      <div className="ambient-backdrop-vignette" />
    </div>
  );
}