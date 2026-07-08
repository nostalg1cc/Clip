import { Fragment, useMemo } from "react";
import type React from "react";
import { Card, ColorCard } from "./ClipCard";
import { effectiveKind, type ClipboardEntry } from "../clipUtils";

const CARD_GAP = 14;
const DIVIDER_WIDTH = 8;
const BUFFER_PX = 1200;
const DEFAULT_CARD_HEIGHT = 320;

export type ClipViewport = {
  left: number;
  width: number;
  height: number;
};

export type ClipLayoutItem = {
  kind: "card" | "divider";
  key: string;
  entry?: ClipboardEntry;
  left: number;
  width: number;
};

export function clipCardHeight(viewport: ClipViewport): number {
  return viewport.height > 0 ? viewport.height : DEFAULT_CARD_HEIGHT;
}

function aspectForEntry(entry: ClipboardEntry): number {
  const kind = effectiveKind(entry);
  const url = entry.text.trim();
  const youtube = kind === "link" && /^(https?:\/\/)?([^/]+\.)?(youtube\.com|youtu\.be)\//i.test(url);
  if ((kind === "image" || kind === "file") && entry.img_w && entry.img_h) {
    return Math.min(Math.max(entry.img_w / entry.img_h, 0.66), 21 / 9);
  }
  if (youtube) return 16 / 9;
  return 1;
}

export function buildClipLayout(entries: ClipboardEntry[], cardHeight: number): { items: ClipLayoutItem[]; totalWidth: number } {
  let cursor = 0;
  const items: ClipLayoutItem[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const showDivider = i > 0 && entries[i - 1].pinned && !entry.pinned;
    if (showDivider) {
      cursor += CARD_GAP;
      items.push({ kind: "divider", key: `divider-${entry.id}`, left: cursor, width: DIVIDER_WIDTH });
      cursor += DIVIDER_WIDTH + CARD_GAP;
    } else if (i > 0) {
      cursor += CARD_GAP;
    }

    const width = Math.max(80, cardHeight * aspectForEntry(entry));
    items.push({ kind: "card", key: entry.id, entry, left: cursor, width });
    cursor += width;
  }
  return { items, totalWidth: cursor };
}

export function visibleClipLayoutItems(items: ClipLayoutItem[], viewport: ClipViewport, buffer = BUFFER_PX): ClipLayoutItem[] {
  const minLeft = Math.max(0, viewport.left - buffer);
  const maxRight = viewport.left + viewport.width + buffer;
  return items.filter((item) => item.left + item.width >= minLeft && item.left <= maxRight);
}

export function visibleClipEntries(entries: ClipboardEntry[], viewport: ClipViewport): ClipboardEntry[] {
  const { items } = buildClipLayout(entries, clipCardHeight(viewport));
  return visibleClipLayoutItems(items, viewport)
    .filter((item) => item.kind === "card" && item.entry)
    .map((item) => item.entry!);
}

function Spacer({ width }: { width: number }) {
  if (width <= 0) return null;
  return <div className="clip-virtual-spacer" style={{ width }} />;
}

export function VirtualClipStrip({
  entries,
  viewport,
  notify,
  onPin,
  onDelete,
  onRename,
  onContextMenu,
}: {
  entries: ClipboardEntry[];
  viewport: ClipViewport;
  notify: (m: string) => void;
  onPin: (id: string) => void;
  onDelete: (id: string, e: React.MouseEvent) => void;
  onRename: (id: string, name: string) => void;
  onContextMenu: (e: React.MouseEvent, entry: ClipboardEntry) => void;
}) {
  const cardHeight = clipCardHeight(viewport);
  const { items, totalWidth } = useMemo(() => buildClipLayout(entries, cardHeight), [entries, cardHeight]);
  const visibleItems = visibleClipLayoutItems(items, viewport);
  let cursor = 0;

  return (
    <div className="clip-virtual-track" style={{ width: totalWidth }}>
      {visibleItems.map((item) => {
        const gap = item.left - cursor;
        cursor = item.left + item.width;
        if (item.kind === "divider") {
          return (
            <Fragment key={item.key}>
              <Spacer width={gap} />
              <div className="clip-virtual-divider" style={{ width: item.width }}>
                <div className="pin-divider" />
              </div>
            </Fragment>
          );
        }
        const entry = item.entry!;
        return (
          <Fragment key={item.key}>
            <Spacer width={gap} />
            <div className="clip-virtual-item" style={{ width: item.width }}>
              {effectiveKind(entry) === "color" ? (
                <ColorCard entry={entry} onPin={onPin} onDelete={onDelete} notify={notify} onContextMenu={onContextMenu} />
              ) : (
                <Card entry={entry} onPin={onPin} onDelete={onDelete} onRename={onRename} onContextMenu={onContextMenu} />
              )}
            </div>
          </Fragment>
        );
      })}
      <Spacer width={totalWidth - cursor} />
    </div>
  );
}