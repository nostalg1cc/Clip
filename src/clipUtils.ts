import hljs from "highlight.js";

// Verse (Epic's UEFN language) isn't in highlight.js — register a lightweight
// grammar so it highlights too. Keywords/specifiers/strings/comments/numbers.
if (!hljs.getLanguage("verse")) {
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
}

export interface ClipboardEntry {
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

export type Kind =
  | "text" | "code" | "json" | "xml" | "markdown" | "csv"
  | "link" | "email" | "phone" | "path" | "color" | "image" | "file";
export type Group = "text" | "code" | "link" | "image" | "color" | "file";
export type Filter = "all" | "pinned" | "emoji" | "downloader" | "settings" | Group;

export const KIND_LABEL: Record<Kind, string> = {
  text: "Text", code: "Code", json: "JSON", xml: "XML", markdown: "Markdown", csv: "CSV",
  link: "Link", email: "Email", phone: "Phone", path: "Path", color: "Color", image: "Image", file: "File",
};
export const GROUP_LABEL: Record<Group, string> = {
  text: "Text", code: "Code", link: "Link", image: "Image", file: "Files", color: "Color",
};
export const GROUP_ORDER: Group[] = ["text", "code", "link", "image", "file", "color"];
export const KIND_FALLBACK_COLOR: Record<Kind, string> = {
  text: "#3c4250", code: "#2c2945", json: "#1d463f", xml: "#5a3a1f", markdown: "#39414e",
  csv: "#1f4540", link: "#1d3a66", email: "#244a7a", phone: "#1f5538", path: "#5a4420",
  color: "#333333", image: "#17171b", file: "#3a3a44",
};

export function filterGroup(kind: Kind): Group {
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
function proseLineRatio(lines: string[]): number {
  if (!lines.length) return 0;
  const proseLines = lines.filter((line) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    return words.length >= 7 && /[.!?]["')\]]*$/.test(line.trim());
  }).length;
  return proseLines / lines.length;
}

function looksLikeCode(t: string): boolean {
  const lines = t.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length);
  if (!lines.length) return false;

  const codeLines = lines.filter((line) => {
    const s = line.trim();
    return /^(import|export)\s+.+\s+from\s+["']/.test(s)
      || /^(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(s)
      || /^(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(s)
      || /^(def|fn)\s+[A-Za-z_][\w]*\s*\(/.test(s)
      || /^(class|interface|enum|struct)\s+[A-Za-z_][\w]*/.test(s)
      || /^#include\s*[<"]/.test(s)
      || /\b(console\.log|System\.out|println!)\s*\(/.test(s)
      || /[{};]\s*$/.test(s)
      || /^\s*[)}\]]\s*[;,]?$/.test(line);
  }).length;

  const proseRatio = proseLineRatio(lines);
  const hasParagraphs = /\S[.!?]["')\]]?\s*\r?\n\s*\r?\n\s*\S/.test(t);
  if ((proseRatio >= 0.35 || hasParagraphs) && codeLines < 3) return false;

  let score = 0;
  if (/```[\s\S]*```/.test(t)) score += 4;
  if (/^(import|export)\s+.+\s+from\s+["']/m.test(t)) score += 3;
  if (/\b(const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(t)) score += 2;
  if (/\b(async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/.test(t)) score += 2;
  if (/\b(def|fn)\s+[A-Za-z_][\w]*\s*\(/.test(t)) score += 2;
  if (/\b(class|interface|enum|struct)\s+[A-Za-z_][\w]*/.test(t)) score += 2;
  if (/=>|==={0,1}|!==|&&|\|\||::|->/.test(t)) score += 1;
  if ((t.match(/[{};]/g) || []).length >= 3) score += 1;
  if (codeLines >= 3) score += 2;
  if (codeLines >= Math.max(2, Math.ceil(lines.length * 0.45))) score += 2;

  return score >= 3;
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
const kindCache = new Map<string, { text: string; image: boolean; filesKey: string; kind: Kind }>();
export function effectiveKind(e: ClipboardEntry): Kind {
  const image = !!e.image_data;
  const filesKey = e.files?.join("\u0000") ?? "";
  const cached = kindCache.get(e.id);
  if (cached && cached.text === e.text && cached.image === image && cached.filesKey === filesKey) return cached.kind;
  const kind = e.files && e.files.length ? "file" : image ? "image" : detectKind(e.text);
  kindCache.set(e.id, { text: e.text, image, filesKey, kind });
  if (kindCache.size > 1000) kindCache.delete(kindCache.keys().next().value!);
  return kind;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function processColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) { hash = name.charCodeAt(i) + ((hash << 5) - hash); hash |= 0; }
  return `hsl(${Math.abs(hash) % 360}, 55%, 34%)`;
}
export const colorCache = new Map<string, string | null>();
export async function dominantColor(src: string): Promise<string | null> {
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
export function timeAgo(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return "just now";
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
export function domainOf(url: string): string {
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

const codeInfoCache = new Map<string, { html: string; language?: string } | null>();
export function cachedCodeInfoFor(kind: Kind, text: string): { html: string; language?: string } | null {
  if (kind !== "json" && kind !== "xml" && kind !== "code") return null;
  const key = `${kind}\u0000${text}`;
  if (codeInfoCache.has(key)) return codeInfoCache.get(key)!;
  const info = codeInfoFor(kind, text);
  codeInfoCache.set(key, info);
  if (codeInfoCache.size > 300) codeInfoCache.delete(codeInfoCache.keys().next().value!);
  return info;
}

/// Proper display name for a highlight.js language id ("verse" → "Verse",
/// "typescript" → "TypeScript"). Falls back to a capitalized id.
export function langDisplayName(id: string): string {
  const name = hljs.getLanguage(id)?.name;
  if (name) return name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}
export function renderMarkdown(raw: string): string {
  let h = escapeHtml(raw);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  h = h.replace(/^(#{1,6})\s+(.*)$/gm, (_m, _hashes, t) => `<span class="md-h">${t}</span>`);
  h = h.replace(/\[([^\]]+)\]\([^)]+\)/g, '<span class="md-link">$1</span>');
  h = h.replace(/^\s*[-*+]\s+(.*)$/gm, "•&nbsp;$1");
  return h;
}
export function metaText(kind: Kind, e: ClipboardEntry): string {
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
export function parseColor(s: string): RGB | null {
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
export function colorFormats(rgb: RGB): { label: string; value: string }[] {
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
