<p align="center">
  <img src="assets/icon.png" width="128" alt="WordLite">
</p>

<h1 align="center">WordLite 简写</h1>

<p align="center">
  <b>An offline, lightweight desktop word processor that feels like Word</b><br>
  Open it and write. No network, no account, no data collection.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-2b5fd0">
  <img alt="Offline" src="https://img.shields.io/badge/network-100%25%20offline-2e9e6b">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-45-47848f">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-f0a020">
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
  <img src="docs/screenshot.png" width="860" alt="WordLite screenshot">
</p>

> The user interface is currently in Simplified Chinese only.

## Why

Writing a notice, an article or a checklist with a table rarely needs a full office suite — and you may not want your files in the cloud.
WordLite does one thing: **format text on your own machine, save it as DOCX, or print / export it to PDF.**

- 🔒 **Fully offline** — all network requests are blocked; files are only read and written through system dialogs
- 📄 **DOCX compatible** — opens Word / WPS documents and saves files they can open
- 🪶 **Familiar** — Home / Insert / Layout / File ribbon, Word-style shortcuts
- 💾 **Never lose a draft** — periodic autosave with crash recovery

## Download

1. Grab `WordLite-<version>-portable.zip` from [Releases](../../releases/latest)
2. Extract it anywhere (**keep the whole folder**, not just the exe)
3. Run `WordLite.exe`

> If the release provides split parts (`.zip.001`, `.zip.002`, ...), download **all parts** plus `JoinParts.ps1` and `合并解压.bat` into one folder, then run `合并解压.bat` to rebuild the zip before extracting.

> Portable: no installer, no registry entries — delete the folder to uninstall.
> Builds are not code-signed yet. If SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.

## Features

| Area | What you can do |
| --- | --- |
| Files | Open / save DOCX and TXT (auto-detects UTF-8, UTF-16, GBK), recent files, autosave and crash recovery |
| Text | Font, size, color, highlight, bold, italic, underline, strikethrough, super/subscript, letter spacing, format painter |
| Paragraphs | Headings 1–3, alignment, indent, line height, spacing before/after, bulleted and numbered lists |
| Tables | Insert, drag column widths, merge / split cells, cell shading, border width and color |
| Images | Insert, precise resize, left / center / right align, text wrapping, crop, replace, delete |
| Page | Paper size, orientation, custom margins, page background, page breaks |
| Output | Print preview, page ranges and copies, export to PDF |

Press <kbd>F1</kbd> in the app for the full shortcut list (Ctrl+N/O/S/P, Ctrl+B/I/U, Ctrl+1/2/3, Ctrl+L/E/R/J, Ctrl+Enter for page break, …).

## Run from source

Requires [Node.js](https://nodejs.org/) 22+.

```bash
git clone <this-repo-url>
cd wordlite
npm install
npm start          # build and launch
```

```bash
npm run build      # build renderer/bundle.js only
npm run smoke      # build + launch smoke test (exits automatically)
node tools/package-portable.cjs   # build the Windows portable zip into dist/
```

If the window never appears, check whether the environment variable `ELECTRON_RUN_AS_NODE` is set — it makes Electron run as plain Node. Unset it, or use `启动简写.bat`, which clears it for you.

## Privacy & security

- Renderer runs with `contextIsolation` + `sandbox`, `nodeIntegration` off
- Only a minimal file / print API is exposed via preload
- All `http` / `https` / `ws` / `wss` requests are blocked
- Every browser permission is denied except clipboard read
- No analytics, no telemetry, no auto-update

## Known limitations

- Only Windows is packaged and tested; macOS / Linux may run from source but are untested
- Print / PDF pagination follows page breaks; automatic page flow of long paragraphs may differ slightly from the screen
- Text boxes, nested tables and complex fields are simplified on DOCX import
- Image text wrapping supports left and right only
- No code signing or installer yet

## Contributing

Issues and pull requests are welcome. Please run `npm run smoke` before submitting.
For bug reports, attaching a (sanitized) sample document that reproduces the problem helps a lot.

## Acknowledgements

[Electron](https://www.electronjs.org/) · [TipTap](https://tiptap.dev/) / [ProseMirror](https://prosemirror.net/) · [docx](https://github.com/dolanmiu/docx) · [mammoth](https://github.com/mwilliamson/mammoth.js) · [JSZip](https://stuk.github.io/jszip/)

### AI assistance

- [DeepSeek](https://www.deepseek.com/) — development assistance
- [Kimi](https://kimi.moonshot.cn/) — development assistance

## License

[MIT](LICENSE)
