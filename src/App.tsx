import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { SearchBox, TabList, Tab, Button } from "@fluentui/react-components";
import hljs from "highlight.js"; // full build — ~190 languages, auto-detected
import { EMOJI_CATEGORIES, ALL_EMOJI_ITEMS, SKIN_TONES, applyTone } from "./emojis";
import "./App.css";

// Verse (Epic's UEFN language) isn't in highlight.js — register a lightweight
// grammar so it highlights too. Keywords/specifiers/strings/comments/numbers.
hljs.registerLanguage("verse", (hl) => ({
  name: "Verse",
  keywords: {
    keyword:
      "if then else for do while loop return break continue yield defer spawn branch race rush sync " +
      "case block using import module class struct enum interface var set option where and or not of " +
      "type extends super external",
    literal: "true false",
    built_in: "int float logic string char void tuple array map comparable subtype castable_subtype Print",
  },
  contains: [
    hl.COMMENT("<#", "#>"),
    hl.COMMENT("#", "$"),
    hl.QUOTE_STRING_MODE,
    hl.C_NUMBER_MODE,
    // <public>, <override>, <native>, <transacts>, … effect/access specifiers
    { className: "meta", begin: /<[A-Za-z_]\w*>/ },
    // identifiers that look like a definition: name := / name(
    { className: "title", begin: /[A-Za-z_]\w*(?=\s*(:=|\())/, relevance: 0 },
  ],
}));

interface ClipboardEntry {
  id: string;
  text: string;
  process: string;
  process_icon: string | null;
  timestamp: number;
  char_count: number;
  image_data: string | null;
  pinned: boolean;
  img_w?: number;
  img_h?: number;
  name?: string | null;
  files?: string[];
}

type Kind =
  | "text" | "code" | "json" | "xml" | "markdown" | "csv"
  | "link" | "email" | "phone" | "path" | "color" | "image" | "file";
type Group = "text" | "code" | "link" | "image" | "color" | "file";
type Filter = "all" | "pinned" | "emoji" | "downloader" | Group;

const KIND_LABEL: Record<Kind, string> = {
  text: "Text", code: "Code", json: "JSON", xml: "XML", markdown: "Markdown", csv: "CSV",
  link: "Link", email: "Email", phone: "Phone", path: "Path", color: "Color", image: "Image", file: "File",
};
const GROUP_LABEL: Record<Group, string> = {
  text: "Text", code: "Code", link: "Link", image: "Image", file: "Files", color: "Color",
};
const GROUP_ORDER: Group[] = ["text", "code", "link", "image", "file", "color"];
const KIND_FALLBACK_COLOR: Record<Kind, string> = {
  text: "#3c4250", code: "#2c2945", json: "#1d463f", xml: "#5a3a1f", markdown: "#39414e",
  csv: "#1f4540", link: "#1d3a66", email: "#244a7a", phone: "#1f5538", path: "#5a4420",
  color: "#333333", image: "#17171b", file: "#3a3a44",
};

function filterGroup(kind: Kind): Group {
  if (kind === "image") return "image";
  if (kind === "file") return "file";
  if (kind === "link") return "link";
  if (kind === "color") return "color";
  if (kind === "code" || kind === "json" || kind === "xml" || kind === "markdown" || kind === "csv") return "code";
  return "text"; // text, email, phone, path
}

// ── Content-type detection (conservative — unsure ⇒ text) ───────────────────────

function isColor(s: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)
    || /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i.test(s)
    || /^hsla?\(\s*\d{1,3}(?:deg)?\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i.test(s);
}
function isPath(s: string): boolean {
  if (/[\r\n\t]/.test(s)) return false;
  if (/^[A-Za-z]:[\\/][^<>:"|?*\r\n]*$/.test(s)) return true;         // C:\… or C:/…
  if (/^\\\\[^\\/:*?"<>|\r\n]+\\[^<>:"|?*\r\n]*$/.test(s)) return true; // UNC
  return false;
}
function isPhone(s: string): boolean {
  const digits = (s.match(/\d/g) || []).length;
  if (digits < 7 || digits > 15) return false;
  if (/^\+\d[\d\s().-]{5,}\d$/.test(s)) return true;                     // +1 555 123 4567
  if (/^\(?\d{2,4}\)?[\s.-]\d{2,4}[\s.-]\d{2,9}$/.test(s)) return true;  // grouped
  return false;
}
function isCsv(s: string): boolean {
  const lines = s.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) return false;
  if (lines.some((l) => l.length > 200)) return false;
  const counts = lines.map((l) => (l.match(/,/g) || []).length);
  return counts[0] >= 1 && counts.every((c) => c === counts[0]);
}
function isXml(s: string): boolean {
  if (!s.startsWith("<") || !s.endsWith(">")) return false;
  if (/^<\?xml/i.test(s)) return true;
  const m = s.match(/^<([a-zA-Z][\w:-]*)(?:\s[^>]*)?>/);
  if (m) return s.includes(`</${m[1]}`) || /\/>\s*$/.test(s);
  return /^<[a-zA-Z][\w:-]*(?:\s[^>]*)?\/>$/.test(s);
}
function isMarkdown(s: string): boolean {
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(s)) score += 2;
  if (/```[\s\S]*```/.test(s)) score += 2;
  if (/(^|\n)\s*[-*+]\s+\S.*\n\s*[-*+]\s+\S/.test(s)) score += 2;
  if (/(^|\n)\s*\d+\.\s+\S/.test(s)) score += 1;
  if (/\[[^\]]+\]\([^)]+\)/.test(s)) score += 1;
  if (/(^|\n)>\s+\S/.test(s)) score += 1;
  if (/\|[^\n]+\|\s*\n\s*\|?[\s:|-]+\|/.test(s)) score += 2;
  return score >= 2;
}
function looksLikeCode(t: string): boolean {
  const markers = [
    "=>", "function ", "const ", "let ", "var ", "def ", "class ", "import ",
    "#include", "public ", "private ", "void ", "fn ", "console.log", "System.out",
    "println", "#!/", "() {", ");",
  ];
  const hits = markers.filter((m) => t.includes(m)).length;
  const hasBlock = t.includes("{") && t.includes("}") && t.includes("\n");
  const semiLines = t.split("\n").filter((l) => l.trimEnd().endsWith(";")).length;
  return (hits >= 1 && (t.includes("\n") || hits >= 2)) || (hasBlock && semiLines >= 2);
}

const VERSE_SPECIFIER = /<(?:public|private|internal|protected|epic_internal|override|native|final|abstract|unique|concrete|castable|persistent|suspends|decides|transacts|varies|computes|converges|reads|writes|allocates|no_rollback|constructor)>/;

/// Verse (UEFN) is brace-/semicolon-free and indentation-based, so it slips past
/// looksLikeCode. Detect it by its signatures instead.
function isVerse(s: string): boolean {
  let score = 0;
  if (VERSE_SPECIFIER.test(s)) score += 2;                       // <override>, <public>, …
  if (/:=/.test(s)) score += 1;                                  // definitions
  if (/\bclass\s*\([^)]*\)\s*:/.test(s)) score += 2;             // X := class(base):
  if (/<#[\s\S]*?#>/.test(s)) score += 1;                        // block comment
  if (/\b(?:creative_device|creative_prop|fort_character|agent|logic|payload)\b/.test(s)) score += 1;
  if (/\)\s*<[a-z_]+>\s*:\w+\s*=/.test(s)) score += 2;           // method<suspends>:void=
  return score >= 2;
}

/// Force a specific grammar for languages highlight.js can't reliably auto-detect
/// (currently just Verse). Returns undefined ⇒ let hljs auto-detect.
function guessLang(s: string): string | undefined {
  return isVerse(s) ? "verse" : undefined;
}

function detectKind(text: string): Kind {
  const s = text.trim();
  if (!s) return "text";
  if (/^https?:\/\/\S+$/i.test(s) && !/\s/.test(s)) return "link";
  if (/^[a-zA-Z0-9._%+-]+@(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}$/.test(s)) return "email";
  if (isColor(s)) return "color";
  if (isPhone(s)) return "phone";
  if (isPath(s)) return "path";
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { JSON.parse(s); return "json"; } catch { /* not json */ }
  }
  if (isXml(s)) return "xml";
  if (isCsv(s)) return "csv";
  if (isVerse(s)) return "code";
  if (isMarkdown(s)) return "markdown";
  if (looksLikeCode(s)) return "code";
  return "text";
}
function effectiveKind(e: ClipboardEntry): Kind {
  if (e.files && e.files.length) return "file";
  if (e.image_data) return "image";
  return detectKind(e.text);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function processColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) { hash = name.charCodeAt(i) + ((hash << 5) - hash); hash |= 0; }
  return `hsl(${Math.abs(hash) % 360}, 55%, 34%)`;
}
const colorCache = new Map<string, string | null>();
async function dominantColor(src: string): Promise<string | null> {
  if (colorCache.has(src)) return colorCache.get(src)!;
  return new Promise((resolve) => {
    const finish = (v: string | null) => { colorCache.set(src, v); resolve(v); };
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width; canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { finish(null); return; }
      ctx.drawImage(img, 0, 0);
      try {
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        // Weight pixels by saturation so the icon's vivid brand hue dominates
        // instead of washing out to a muddy grey average.
        let rw = 0, gw = 0, bw = 0, wsum = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] < 100) continue;
          const r = data[i], g = data[i + 1], b = data[i + 2];
          const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
          const sat = mx === 0 ? 0 : (mx - mn) / mx;
          const w = sat * sat * 255 + 6;
          rw += r * w; gw += g * w; bw += b * w; wsum += w;
        }
        if (wsum === 0) { finish(null); return; }
        // Keep the accurate hue, push saturation up, pin lightness dark enough for white text
        const [h, s] = rgbToHsl(rw / wsum, gw / wsum, bw / wsum);
        const vivid = Math.min(92, Math.max(40, s * 1.35 + 10));
        const { r, g, b } = hslToRgb(h, vivid, 35);
        finish(`rgb(${r},${g},${b})`);
      } catch { finish(null); }
    };
    img.onerror = () => finish(null);
    img.src = src;
  });
}
function timeAgo(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return "just now";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}
/// Syntax-highlight code into hljs-classed HTML. When the language is known
/// (json/xml) we tell hljs directly; otherwise it auto-detects across the common
/// language set. Falls back to plain escaped text on any error.
function highlightCode(text: string, lang?: string): { html: string; language?: string } {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return { html: hljs.highlight(text, { language: lang, ignoreIllegals: true }).value, language: lang };
    }
    const r = hljs.highlightAuto(text);
    return { html: r.value, language: r.language };
  } catch {
    return { html: escapeHtml(text) };
  }
}

/// Highlighted HTML + detected language for the code-ish kinds; null otherwise.
function codeInfoFor(kind: Kind, text: string): { html: string; language?: string } | null {
  if (kind === "json") {
    let src = text;
    try { src = JSON.stringify(JSON.parse(text), null, 2); } catch { /* keep raw */ }
    return highlightCode(src, "json");
  }
  if (kind === "xml") return highlightCode(text, "xml");
  if (kind === "code") return highlightCode(text, guessLang(text));
  return null;
}

/// Proper display name for a highlight.js language id ("verse" → "Verse",
/// "typescript" → "TypeScript"). Falls back to a capitalized id.
function langDisplayName(id: string): string {
  const name = hljs.getLanguage(id)?.name;
  if (name) return name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
function renderMarkdown(raw: string): string {
  let h = escapeHtml(raw);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  h = h.replace(/^(#{1,6})\s+(.*)$/gm, (_m, _hashes, t) => `<span class="md-h">${t}</span>`);
  h = h.replace(/\[([^\]]+)\]\([^)]+\)/g, '<span class="md-link">$1</span>');
  h = h.replace(/^\s*[-*+]\s+(.*)$/gm, "•&nbsp;$1");
  return h;
}
function metaText(kind: Kind, e: ClipboardEntry): string {
  switch (kind) {
    case "image": return e.img_w && e.img_w > 0 ? `${e.img_w} × ${e.img_h}` : "Image";
    case "link": return domainOf(e.text.trim());
    case "json": return "JSON";
    case "xml": return "XML";
    case "markdown": return "Markdown";
    case "csv": return `${e.text.trim().split(/\r?\n/).filter(Boolean).length} rows`;
    case "code": return `${e.text.split("\n").length} lines`;
    case "email": return "Email address";
    case "phone": return "Phone number";
    case "path": return "File path";
    case "file": {
      const fs = e.files ?? [];
      if (fs.length > 1) return `${fs.length} files`;
      return (fs[0] ?? e.text).split(/[\\/]/).filter(Boolean).pop() || "File";
    }
    default: return `${(e.char_count || e.text.length).toLocaleString()} characters`;
  }
}

// ── Color parsing / conversion ──────────────────────────────────────────────────

interface RGB { r: number; g: number; b: number }
function parseColor(s: string): RGB | null {
  s = s.trim();
  let m = s.match(/^#([0-9a-f]{3})$/i);
  if (m) { const h = m[1]; return { r: parseInt(h[0] + h[0], 16), g: parseInt(h[1] + h[1], 16), b: parseInt(h[2] + h[2], 16) }; }
  m = s.match(/^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i);
  if (m) { const h = m[1]; return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; }
  m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  m = s.match(/^hsla?\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%/i);
  if (m) return hslToRgb(+m[1], +m[2], +m[3]);
  return null;
}
function hslToRgb(h: number, s: number, l: number): RGB {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(l * 100)];
}
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0; const s = max === 0 ? 0 : d / max; const v = max;
  if (d !== 0) {
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [Math.round(h * 360), Math.round(s * 100), Math.round(v * 100)];
}
function colorFormats(rgb: RGB): { label: string; value: string }[] {
  const { r, g, b } = rgb;
  const hex = "#" + [r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  const [h, s, l] = rgbToHsl(r, g, b);
  const [, sv, v] = rgbToHsv(r, g, b);
  return [
    { label: "HEX", value: hex },
    { label: "RGB", value: `rgb(${r}, ${g}, ${b})` },
    { label: "HSL", value: `hsl(${h}, ${s}%, ${l}%)` },
    { label: "HSV", value: `hsv(${h}, ${sv}%, ${v}%)` },
  ];
}

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

// ── Drag-to-scroll with inertia ─────────────────────────────────────────────────

function useDragScroll(ref: React.RefObject<HTMLDivElement | null>) {
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

function ColorCard({
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
}

// ── Unified card ───────────────────────────────────────────────────────────────

function Card({
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

  const codeInfo = useMemo(() => codeInfoFor(kind, entry.text), [kind, entry.text]);

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
            {kind === "file" && (
              <button className="action-btn open-btn"
                onClick={(e) => { e.stopPropagation(); invoke("reveal_in_explorer", { path: entry.files?.[0] ?? entry.text }); }}
                aria-label="Open file location">
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
}

// ── Emoji picker ───────────────────────────────────────────────────────────────

function loadRecentEmojis(): string[] {
  try { return JSON.parse(localStorage.getItem("emoji-recents") || "[]"); } catch { return []; }
}
function pushRecentEmoji(emoji: string) {
  const cur = loadRecentEmojis().filter((x) => x !== emoji);
  cur.unshift(emoji);
  localStorage.setItem("emoji-recents", JSON.stringify(cur.slice(0, 20)));
}

function EmojiView({ search, notify }: { search: string; notify: (msg: string) => void }) {
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

// ── Top bar ────────────────────────────────────────────────────────────────────

function TopBar({
  search, onSearch, filter, onFilter, total, tabs, onClear, emojiIcon,
}: {
  search: string;
  onSearch: (v: string) => void;
  filter: Filter;
  onFilter: (f: Filter) => void;
  total: number;
  tabs: { key: Filter; label: string; count?: number }[];
  onClear: () => void;
  emojiIcon: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const clearClick = () => {
    if (confirming) { onClear(); setConfirming(false); }
    else { setConfirming(true); setTimeout(() => setConfirming(false), 2500); }
  };

  return (
    <div className="top-bar">
      <SearchBox
        className="fluent-search"
        size="small"
        appearance="filled-darker"
        placeholder={filter === "emoji" ? "Search emoji…" : "Search clips…"}
        value={search}
        // The bar floats without focus (so pasting never dismisses password
        // popups); clicking the search box asks the backend to take focus so
        // the user can actually type.
        onMouseDown={() => { invoke("focus_search").catch(() => {}); }}
        onChange={(_, d) => onSearch(d.value)}
        onKeyDown={(e) => { if (e.key === "Escape") onSearch(""); e.stopPropagation(); }}
      />

      <div className="top-bar-tabs">
        <TabList
          selectedValue={filter}
          onTabSelect={(_, d) => onFilter(d.value as Filter)}
          size="small"
        >
          {tabs.map(({ key, label, count }) => (
            <Tab
              key={key}
              value={key}
              icon={key === "emoji" ? <span className="tab-emoji-icon">{emojiIcon}</span> : undefined}
            >
              {key === "emoji" ? "Emoji" : label}
              {count !== undefined && count > 0 && <span className="tab-count">{count}</span>}
            </Tab>
          ))}
        </TabList>
      </div>

      {filter !== "emoji" && total > 0 && (
        <Button
          size="small"
          appearance={confirming ? "primary" : "subtle"}
          onClick={clearClick}
        >
          {confirming ? "Clear all?" : "Clear"}
        </Button>
      )}
    </div>
  );
}

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
    case "downloading": return `Downloading ${percent.toFixed(0)}%`;
    case "processing": return "Finishing up…";
    case "compressing": return "Compressing to size…";
    case "error": return "Failed";
    default: return "…";
  }
}

interface DlJob { stage: string; percent: number; message?: string }

function DownloaderView({
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
  const [format, setFormat] = useState<"mp4" | "mp3">("mp4");
  const [quality, setQuality] = useState("best");
  const [targetMb, setTargetMb] = useState(0);
  const [jobs, setJobs] = useState<Record<string, DlJob>>({});

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
            <div className="dl-seg-row">
              <button className={`dl-seg${format === "mp4" ? " on" : ""}`} onClick={() => setFormat("mp4")}>MP4</button>
              <button className={`dl-seg${format === "mp3" ? " on" : ""}`} onClick={() => setFormat("mp3")}>MP3</button>
            </div>
            {format === "mp4" && (
              <>
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
                <label className="dl-field"><span>Fit to size</span>
                  <select value={targetMb} onMouseDown={focus} onChange={(e) => setTargetMb(Number(e.target.value))}>
                    <option value={0}>No limit</option>
                    <option value={10}>Discord · 10 MB</option>
                    <option value={25}>25 MB</option>
                    <option value={50}>50 MB</option>
                    <option value={100}>100 MB</option>
                  </select>
                </label>
              </>
            )}
            <button className="dl-btn primary" onClick={download} disabled={!url.trim()}>Download</button>
            {activeJobs.length > 0 && (
              <div className="dl-jobs">
                {activeJobs.map(([id, j]) => (
                  <div className={`dl-job${j.stage === "error" ? " err" : ""}`} key={id}>
                    <div className="dl-job-bar">
                      <div className="dl-job-fill" style={{ width: `${j.stage === "downloading" ? j.percent : 100}%` }} />
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

// ── Context menu ─────────────────────────────────────────────────────────────

interface CtxMenuState { x: number; y: number; entry: ClipboardEntry }
interface LocalSendPeer { fingerprint: string; alias: string; ip: string; port: number; deviceType?: string }
interface LocalSendHistoryEntry { ip: string; port: number; alias?: string; lastUsedMs: number }

function ContextMenu({
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
  const toastTimer = useRef<number | undefined>(undefined);
  const drag = useDragScroll(scrollRef);

  const notify = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1300);
  };

  const updateFades = () => {
    const el = scrollRef.current; if (!el) return;
    el.classList.toggle("can-left", el.scrollLeft > 4);
    el.classList.toggle("can-right", el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };

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
    updateFades();
  }, [filter, search]);

  const handlePin = async (id: string) => {
    const newPinned = await invoke<boolean>("toggle_pin", { id });
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, pinned: newPinned } : e)));
  };
  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await invoke("delete_clip", { id });
    setEntries((prev) => prev.filter((entry) => entry.id !== id));
  };
  const handleRename = async (id: string, name: string) => {
    await invoke("rename_clip", { id, name });
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, name: name.trim() || null } : e)));
  };
  const handleCopy = (id: string) => { invoke("copy_clip", { id }); notify("Copied to clipboard"); };
  const handleClear = async () => {
    await invoke("clear_history");
    setEntries((prev) => prev.filter((e) => e.pinned));
    notify("Cleared unpinned clips");
  };
  const openContextMenu = (e: React.MouseEvent, entry: ClipboardEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, entry });
  };
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
    return out;
  }, [entries.length, groupCounts]);

  const displayed = useMemo(() => {
    let list = entries;
    if (filter === "pinned") list = list.filter((e) => e.pinned);
    else if (filter !== "all" && filter !== "emoji") list = list.filter((e) => filterGroup(effectiveKind(e)) === filter);
    if (search.trim()) {
      const sq = search.toLowerCase();
      list = list.filter((e) =>
        e.text.toLowerCase().includes(sq) || e.process.toLowerCase().includes(sq) || (e.name ?? "").toLowerCase().includes(sq));
    }
    return [...list.filter((e) => e.pinned), ...list.filter((e) => !e.pinned)];
  }, [entries, search, filter]);
  displayedRef.current = displayed;

  useEffect(() => { updateFades(); }, [displayed.length]);

  const emojiIcon = loadRecentEmojis()[0] || "😀";
  const emptyMsg = search
    ? `No results for "${search}"`
    : filter === "pinned" ? "No pinned clips yet"
    : filter !== "all" ? `No ${String(filter)} clips yet`
    : "Copy something to get started";

  return (
    <div className="app">
      <TopBar
        search={search} onSearch={setSearch}
        filter={filter} onFilter={setFilter}
        total={entries.length} tabs={tabs} onClear={handleClear} emojiIcon={emojiIcon}
      />
      <div
        className={`cards-row${filter === "emoji" ? " is-emoji" : ""}${filter === "downloader" ? " is-downloader" : ""}`}
        ref={scrollRef}
        onScroll={updateFades}
        {...(filter === "emoji" || filter === "downloader" ? {} : drag)}
      >
        {filter === "downloader" ? (
          <DownloaderView
            downloads={entries.filter((e) => e.process === "Downloader")}
            notify={notify}
            onPin={handlePin} onDelete={handleDelete} onRename={handleRename} onContextMenu={openContextMenu}
          />
        ) : filter === "emoji" ? (
          <EmojiView search={search} notify={notify} />
        ) : displayed.length === 0 ? (
          <div className="empty-state">{emptyMsg}</div>
        ) : (
          displayed.map((entry, i) => {
            const showDivider = i > 0 && displayed[i - 1].pinned && !entry.pinned;
            const card = effectiveKind(entry) === "color"
              ? <ColorCard key={entry.id} entry={entry} onPin={handlePin} onDelete={handleDelete} notify={notify} onContextMenu={openContextMenu} />
              : <Card key={entry.id} entry={entry} onPin={handlePin} onDelete={handleDelete} onRename={handleRename} onContextMenu={openContextMenu} />;
            return showDivider
              ? <Fragment key={entry.id}><div className="pin-divider" />{card}</Fragment>
              : card;
          })
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
