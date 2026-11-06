<p align="center">
  <img src="assets/icon.png" width="128" alt="WordLite">
</p>

<h1 align="center">WordLite 简写</h1>

<p align="center">
  <b>An offline, lightweight desktop word processor that feels like Word</b><br>
  Open it and write. No network, no account, no data collection.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20%7C%20macOS%2013%2B-2b5fd0">
  <img alt="Offline" src="https://img.shields.io/badge/network-100%25%20offline-2e9e6b">
  <img alt="Tauri" src="https://img.shields.io/badge/Tauri-2-24c8db">
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

Writing a notice, an article or a checklist with a table rarely needs a full office suite or AI tools — and you may not want your files in the cloud.
WordLite does one thing: **format text on your own machine, save it as DOCX, or print / export it to PDF.**

- 🔒 **Fully offline** — the app makes no network requests; files are read and written through native dialogs
- 📄 **DOCX compatible** — opens Word / WPS documents and saves files they can open
- 🪶 **Lightweight** — Tauri 2 + the system WebView (WebView2 on Windows, WKWebView on macOS); installer is a few MB
- 🪟 **Multi-window** — dropping a file or using "Open with" opens a separate window for side-by-side comparison; in-app opens stay in the current window
- 💾 **Never lose a draft** — periodic autosave with crash recovery

## Download

### Windows 10 / 11

1. Grab `WordLite_<version>_x64-setup.exe` from [Releases](../../releases/latest)
2. Run the installer
3. Launch from the Start menu or desktop

> Builds are not code-signed yet. If SmartScreen shows "Windows protected your PC", click **More info → Run anyway**.
> Requires the Microsoft Edge WebView2 runtime; Windows 11 and most Windows 10 installations already have it.

### macOS 13 Ventura or later

1. Grab `WordLite_<version>_universal.dmg` from [Releases](../../releases/latest) — one package for both Apple silicon and Intel
2. Open the dmg and drag the app into **Applications** (it shows up as 简写 on Chinese systems and as WordLite on English ones)
3. First launch: the build is ad-hoc signed and not notarized, so double-clicking shows "Apple could not verify…". Open **System Settings → Privacy & Security**, click **Open Anyway** in the notice at the bottom, then confirm. macOS will ask for your administrator password; enter it, then click **Open Anyway** again
4. Once installed, the menu bar and the Dock show 简写

> On macOS 13 / 14 you can also hold <kbd>Control</kbd>, click the icon and choose "Open"; macOS 15 removed that shortcut, so use System Settings.
> Requires macOS 13 Ventura or later (Safari 16 WebKit or newer).
> To build it yourself on a Mac, see "Run from source" below.

## Features

| Area | What you can do |
| --- | --- |
| Files | Open / save DOCX and TXT (auto-detects UTF-8, UTF-16, GBK), open via double-click / "Open with" / drag-and-drop, recent files, autosave and crash recovery |
| Editing | Find / replace, case-sensitive search, highlight all matches and jump between them |
| Windows | In-app opens stay in the current window (Save / Don't save / Cancel when modified); drops and "Open with" open a separate window |
| Text | Font, size, color, highlight, bold, italic, underline, strikethrough, super/subscript, letter spacing, format painter |
| Paragraphs | Headings 1–3, alignment, indent, line height, spacing before/after, bulleted and numbered lists |
| Tables | Insert, drag column widths, merge / split cells, cell shading, border width and color |
| Images | Insert, precise resize, left / center / right align, text wrapping, crop, replace, delete |
| Page | Paper size, orientation, custom margins, page background, page breaks |
| Output | Print (page range and copies via the system print dialog), print preview, export to PDF |

<details>
<summary><b>Keyboard shortcuts</b> (also available in the app with <kbd>F1</kbd>, or <kbd>⌘?</kbd> on macOS)</summary>

| Action | Windows | macOS |
| --- | --- | --- |
| New / Open / Save / Save as | <kbd>Ctrl+N</kbd> / <kbd>Ctrl+O</kbd> / <kbd>Ctrl+S</kbd> / <kbd>Ctrl+Shift+S</kbd> | <kbd>⌘N</kbd> / <kbd>⌘O</kbd> / <kbd>⌘S</kbd> / <kbd>⇧⌘S</kbd> |
| Print preview | <kbd>Ctrl+P</kbd> | <kbd>⌘P</kbd> |
| Find / Replace | <kbd>Ctrl+F</kbd> / <kbd>Ctrl+H</kbd> | <kbd>⌘F</kbd> / <kbd>⌥⌘F</kbd> |
| Bold / Italic / Underline | <kbd>Ctrl+B</kbd> / <kbd>Ctrl+I</kbd> / <kbd>Ctrl+U</kbd> | <kbd>⌘B</kbd> / <kbd>⌘I</kbd> / <kbd>⌘U</kbd> |
| Strikethrough | <kbd>Ctrl+Shift+X</kbd> | <kbd>⇧⌘X</kbd> |
| Superscript / Subscript | <kbd>Ctrl+Shift+=</kbd> / <kbd>Ctrl+=</kbd> | <kbd>⇧⌘=</kbd> / <kbd>⌘=</kbd> |
| Increase / Decrease font size | <kbd>Ctrl+Shift+&gt;</kbd> / <kbd>Ctrl+Shift+&lt;</kbd> | <kbd>⇧⌘&gt;</kbd> / <kbd>⇧⌘&lt;</kbd> |
| Format painter: copy / apply | <kbd>Ctrl+Shift+C</kbd> / <kbd>Ctrl+Shift+V</kbd> | <kbd>⇧⌘C</kbd> / <kbd>⇧⌘V</kbd> |
| Heading 1 / 2 / 3 / Body | <kbd>Ctrl+1</kbd> / <kbd>Ctrl+2</kbd> / <kbd>Ctrl+3</kbd> / <kbd>Ctrl+0</kbd> | <kbd>⌘1</kbd> / <kbd>⌘2</kbd> / <kbd>⌘3</kbd> / <kbd>⌘0</kbd> |
| Align left / center / right / justify | <kbd>Ctrl+L</kbd> / <kbd>Ctrl+E</kbd> / <kbd>Ctrl+R</kbd> / <kbd>Ctrl+J</kbd> | <kbd>⌘L</kbd> / <kbd>⌘E</kbd> / <kbd>⌘R</kbd> / <kbd>⌘J</kbd> |
| Bullet / Numbered list | <kbd>Ctrl+Shift+8</kbd> / <kbd>Ctrl+Shift+7</kbd> | <kbd>⇧⌘8</kbd> / <kbd>⇧⌘7</kbd> |
| Increase / Decrease indent | <kbd>Ctrl+M</kbd> / <kbd>Ctrl+Shift+M</kbd> | <kbd>⌘]</kbd> / <kbd>⌘[</kbd> |
| Insert page break | <kbd>Ctrl+Enter</kbd> | <kbd>⌘Enter</kbd> |

On macOS, Ctrl combinations are left to the system (<kbd>Ctrl+A</kbd> / <kbd>Ctrl+E</kbd> / <kbd>Ctrl+K</kbd> still move to line start / end / kill to end of line). Replace uses <kbd>⌥⌘F</kbd> and indent uses <kbd>⌘]</kbd> / <kbd>⌘[</kbd> because <kbd>⌘H</kbd> (Hide) and <kbd>⌘M</kbd> (Minimize) belong to macOS.

</details>

## Run from source

Common requirements:

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://rustup.rs/) stable

On Windows you also need:

- Visual Studio Build Tools (C++ workload) and the Windows SDK
- Microsoft Edge WebView2 runtime

On macOS you also need:

- Xcode Command Line Tools: `xcode-select --install`
- macOS 13.0 Ventura or later (Safari 16 WebKit); building the universal package needs `rustup target add aarch64-apple-darwin x86_64-apple-darwin`

```bash
git clone <this-repo-url>
cd WordLite
npm install
npm run tauri:dev     # build the renderer and launch the Tauri window
```

Build the installer:

```bash
npm run tauri:build   # Windows output: src-tauri/target/release/bundle/nsis/
                      # macOS output:   src-tauri/target/release/bundle/dmg/
npm run build         # rebuild renderer/bundle.js only
```

Build a universal dmg on a Mac (one package for Apple silicon and Intel):

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin --bundles app,dmg
# output: src-tauri/target/universal-apple-darwin/release/bundle/dmg/WordLite_<version>_universal.dmg
```

Self-test:

```bash
# Windows
src-tauri/target/release/wordlite.exe --selftest

# macOS
"src-tauri/target/release/bundle/macos/WordLite.app/Contents/MacOS/wordlite" --selftest
```

> The first bundle run downloads NSIS from GitHub (Windows only); the macOS dmg is produced by tools that ship with the OS.
> Pushing a `v*` tag makes GitHub Actions build both the Windows and the macOS installers and open a draft release (see `.github/workflows/build.yml`).

<details>
<summary><b>Project structure</b></summary>

```text
src-tauri/              Tauri 2 / Rust main process
  src/lib.rs            windows, files, autosave, print / PDF
  tauri.conf.json       window, CSP, bundle configuration
  capabilities/         permissions (main and doc-* windows)
renderer/
  index.html            UI structure
  style.css             UI and print styles
  app.js                editor, ribbon, files, print, settings
  docx.js               DOCX import / export
  extensions.js         custom TipTap extensions (tables, images, paragraph formatting, etc.)
  tauri-bridge.js       window.wordlite compatibility layer for Tauri
tools/
  make-icon.py          icon generation script (Python + Pillow)
assets/                 app icons
docs/                   README screenshot and migration notes
```

`renderer/bundle.js` is a build artifact and is not committed.

</details>

## Privacy & security

- Tauri 2 + Rust backend; the frontend can only call whitelisted commands
- Files are read and written through native system dialogs
- CSP is restricted to `default-src 'self'`; the app makes no network requests
- No analytics, no telemetry, no auto-update

## Known limitations

- Packaged and tested on Windows 10 / 11 and macOS 13 Ventura or later (both Apple silicon and Intel); older macOS versions are untested
- Choosing Quit from the Dock icon's context menu, logging out or shutting down exits without a save prompt; unsaved work is recovered from autosave when you reopen the app
- The macOS build is ad-hoc signed and not notarized, so the first launch needs the steps under "Download"; the Windows build is not code-signed either
- Print preview paginates by content blocks; a single extremely long paragraph without breaks is not split by line in the preview (the PDF / print engine still paginates by line)
- Text boxes, nested tables and complex fields are simplified on DOCX import
- DOCX import restores only direct run formatting: `w:color` text colour, `w:highlight` highlighter and run-level `w:shd` character shading. Theme colours use the cached value in `w:color/@w:val` (a theme colour with no cached value is not restored); colours defined in character or paragraph styles and paragraph shading are not restored. When a run cannot be aligned with confidence it is left uncoloured, so colour never lands on the wrong characters
- Image text wrapping supports left and right only

## FAQ

**SmartScreen says "Windows protected your PC"?**
The build is not signed yet. Click **More info → Run anyway**, then launch from the Start menu.

**macOS says the app cannot be opened because Apple could not verify it?**
It is not notarized, and nothing is wrong with the file. Open **System Settings → Privacy & Security**, click **Open Anyway** in the notice at the bottom, then confirm. macOS will ask for your administrator password; enter it, then click **Open Anyway** again. Double-clicking works normally afterwards.

**WebView2 is missing?**
Install the Microsoft Edge [WebView2](https://developer.microsoft.com/zh-cn/microsoft-edge/webview2) Runtime (Windows 11 and most Windows 10 installations already have it). This only applies to Windows; macOS uses the system WKWebView.

**Where are files stored?**
Wherever you save them. Autosave recovery copies live in `%APPDATA%\com.h1kayemizbitti.wordlite\autosave-*.json` on Windows and in `~/Library/Application Support/com.h1kayemizbitti.wordlite/autosave-*.json` on macOS, and are cleared after a successful save or choosing "Don't save".

## Contributing

Issues and pull requests are welcome. Please run the build and self-test before submitting:

```bash
npm run tauri:build
# Windows
src-tauri/target/release/wordlite.exe --selftest
# macOS
"src-tauri/target/release/bundle/macos/WordLite.app/Contents/MacOS/wordlite" --selftest
```

For bug reports, attaching a (sanitized) sample document that reproduces the problem helps a lot.

## Acknowledgements

- [Tauri](https://tauri.app/) / [WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) / [WKWebView](https://developer.apple.com/documentation/webkit/wkwebview) — desktop shell
- [TipTap](https://tiptap.dev/) / [ProseMirror](https://prosemirror.net/) — editor core
- [docx](https://github.com/dolanmiu/docx) — DOCX export
- [mammoth](https://github.com/mwilliamson/mammoth.js) — DOCX import
- [JSZip](https://stuk.github.io/jszip/) — DOCX packaging

### AI assistance

- [DeepSeek](https://www.deepseek.com/) — development assistance
- [Kimi](https://kimi.moonshot.cn/) — development assistance
- [Claude](https://claude.ai) — development assistance

## Contributors ✨

Thanks goes to these wonderful people ([emoji key](https://allcontributors.org/en/reference/emoji-key/)):

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/custodiet0512"><img src="https://avatars.githubusercontent.com/u/226888570?v=4&size=100" width="100px" height="100px" alt="Wyatt"/><br /><sub><b>Wyatt</b></sub></a><br /><a href="https://github.com/H1kayemizBitti/WordLite/commits?author=custodiet0512" title="Tests">⚠️</a></td>
    </tr>
  </tbody>
  <tfoot>
    <tr>
      <td align="center" size="13px" colspan="7">
        <img src="https://raw.githubusercontent.com/all-contributors/all-contributors-cli/1b8533af435da9854653492b1327a23a4dbd0a10/assets/logo-small.svg">
          <a href="https://all-contributors.js.org/docs/en/bot/usage">Add your contributions</a>
        </img>
      </td>
    </tr>
  </tfoot>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!

## License

[MIT](LICENSE)
