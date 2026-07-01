# Clip

A fast, good-looking clipboard history bar for Windows — built with Tauri v2, React and Fluent UI.

Press a shortcut, a translucent bar slides up from the bottom of the screen with your recent clips. Click one to paste it straight into whatever you were doing. It stays out of the way, never steals focus, and understands what you copied.

## Features

- **Rich, typed clips** — text, images, and copied files, each rendered as a card. Content is auto-detected and displayed accordingly: links, emails, phone numbers, file paths, colors, JSON/XML/Markdown/CSV, and code all get their own treatment (syntax highlighting, color swatches with copyable HEX/RGB/HSL/HSV, YouTube link previews, file thumbnails, and more).
- **Never steals focus** — the bar floats as a non-activating overlay, so clicking a clip pastes into your real target without dismissing focus-sensitive popups (password managers, browser autofill, etc.).
- **Pin, rename, search** — pin clips to keep them, rename them, and type to search across everything.
- **Emoji picker** — a built-in emoji tab with search, skin-tone selection, and recents.
- **Acrylic / Mica backdrop** — a translucent Windows backdrop with light/dark themes, toggleable from the tray.
- **Global shortcut** — open with **Shift+Alt+V** by default, or optionally hijack **Win+V** to replace the built-in Windows clipboard history.
- **Local & private** — history lives in a local SQLite database in your app-data folder. Nothing leaves your machine.
- **Lightweight** — a native window hosting the OS WebView2, not a bundled browser.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Open / close the bar | `Shift+Alt+V` (or `Win+V` if enabled in the tray) |
| Paste the Nth clip | `1`–`9` (after clicking into the bar) |
| Search | Click the search box and start typing |
| Close | `Esc`, or click anywhere outside the bar |

## Tray menu

- **Run at startup** — launch Clip when you sign in.
- **Light mode** — toggle light/dark theme.
- **Acrylic** — switch the backdrop material between Acrylic and Mica.
- **Use Win+V** — free `Win+V` from Explorer and use it to open Clip (requires an Explorer restart or sign-out to take effect; restores cleanly when turned off).
- **Quit**.

## Tech stack

- [Tauri v2](https://tauri.app/) (Rust) — window, tray, global shortcuts, native Win32 integration
- React 19 + TypeScript + Vite
- [Fluent UI](https://react.fluentui.dev/)
- SQLite (`rusqlite`) for storage
- `window-vibrancy` + a legacy `SetWindowCompositionAttribute` accent for the backdrop

## Building from source

Prerequisites: [Node.js](https://nodejs.org/), the [Rust toolchain](https://rustup.rs/), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for Windows (WebView2 + MSVC build tools).

```bash
npm install

# run in dev
npm run tauri dev

# build a release + NSIS installer (output in src-tauri/target/release/bundle/nsis)
npm run tauri build
```

## Platform

Windows 10/11 (the backdrop, Win+V hijack, and clipboard integration are Windows-specific). The codebase compiles on other platforms with those features stubbed out, but it's designed for Windows.

## License

[MIT](LICENSE)
