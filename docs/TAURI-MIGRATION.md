# WordLite Tauri 迁移笔记

分支：`tauri`（独立 worktree `WordLite-tauri`，不影响 Electron 主工作树）

## 目标

- Windows 安装包/绿色版体积从 Electron 的 ≈200MB+ 降到 30MB 以内（目标 15MB 左右）
- 同时获得 macOS 构建能力（Tauri 在 macOS 用系统 WKWebView）
- 渲染层（TipTap、DOCX 导入导出、查找替换、打印预览）尽量零改动

## 目录

```
renderer/tauri-bridge.js    Tauri 下的 window.wordlite 兼容层（Electron 中自动跳过）
src-tauri/                  Tauri 2 Rust 主进程
  src/lib.rs                命令实现：文件、自动保存、窗口、打印
  tauri.conf.json           窗口、CSP、打包配置
  capabilities/default.json 权限
```

## 已实现的 API 映射

| 渲染层调用 | Electron IPC | Tauri command |
| --- | --- | --- |
| showOpenDialog | show-open-dialog | show_open_dialog |
| showSaveDialog | show-save-dialog | show_save_dialog |
| readFile / writeFile | read-file / write-file | read_file / write_file |
| readAutosave / writeAutosave / clearAutosave | 同名 | 同名 |
| confirmAction | confirm-action | confirm_action |
| setDocumentState | document-state | set_document_state |
| closeAfterSave | close-after-save | close_after_save |
| print | print-document | print_document（先走系统打印面板） |
| exportPdf / printToPDF | export-pdf / print-to-pdf | export_pdf / print_to_pdf（原生：Windows 用 WebView2 `PrintToPdf`，macOS 用 `NSPrintOperation`） |
| onSaveBeforeClose | save-before-close 事件 | 同名事件 |
| onOpenFile | open-file-path 事件 | 同名事件（拖放 + argv + 单实例） |
| notifyReady | renderer-ready | renderer_ready |

## 迁移阶段

1. **Shell + 文件 IO（已完成）**：Tauri 窗口加载现有 renderer，编辑、文件读写、自动保存、查找替换、拖放/打开方式、单实例均已接好。
2. **打印 / PDF（Windows 已完成基础版）**：WebView2 `ICoreWebView2_7::PrintToPdf` + `ICoreWebView2Environment6::CreatePrintSettings`，纸张尺寸/边距取渲染层 `@page` 的厘米值；普通打印先走 `window.print()` 系统面板。页码/份数待接 `ICoreWebView2PrintSettings2`。
3. **macOS（已完成，v1.0.1）**：WKWebView / `NSPrintOperation` 导出 PDF、菜单栏、⌘ 快捷键、字体回退、`RunEvent::Opened` 访达打开、Dock 重开窗口、逐窗退出的保存流程；ad-hoc 签名（`tauri.macos.conf.json`），公证未做。Universal 包由 CI 的 `macos-latest` 构建，自测里 PDF 页数必须和预览一致。
4. **发布（v1.0.1 起两个平台一同发布）**：Windows 出 NSIS，macOS 出 Universal dmg，CI 在推送 `v*` 标签时同时构建并建一个草稿 Release，人工检查后 Publish。Electron 版本留在旧分支，只作历史回退。

## 构建与自测

```bash
# 首次（安装 JS 依赖后）
npm install
npm run tauri:dev

# 不装本地 CLI 时也可用
npx -y @tauri-apps/cli@2 build --no-bundle
npx -y @tauri-apps/cli@2 build --bundles nsis
```

```bash
# 自测：编辑器挂载、bridge、IPC 读写、PDF 导出
src-tauri/target/release/wordlite.exe --selftest
```

macOS 上构建和自测（需要 macOS 13+，Xcode Command Line Tools 和 rustup）：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npx tauri build --target universal-apple-darwin --bundles app,dmg
"src-tauri/target/universal-apple-darwin/release/bundle/macos/WordLite.app/Contents/MacOS/wordlite" --selftest --long-print
```

macOS 的 `std::env::temp_dir()` 是 `$TMPDIR`（`/var/folders/...`），CI 里要把 `TMPDIR` 指到 `runner.temp`，否则上传不到 selftest 的 PDF。Windows 上不能链接 macOS，本机只能用 `_cc_handoff/mac-check/check.sh`（占位编译器）做类型检查。

2026-11-03 实测（Windows 11 10.0.26300 / WebView2 156.0.4314.58）：

| 项目 | 结果 |
| --- | --- |
| debug exe | 14.7 MB |
| release exe | 10.2 MiB |
| NSIS 安装包 | 2.62 MiB |
| selftest | `{"autosave":"ok","bridge":true,"editor":true,"findBar":true,"dialogChoice":"save","helpTabs":3,"longChars":18598,"longPdfPages":18,"openedNewWindow":true,"pdfHeader":"%PDF","previewPages":18,"read":"hello","readBinary":"aGVsbG8=","state":"ok","tauri":true,"windowCount":2}` |

> 本机 GitHub 直连超时：首次 `tauri build --bundles nsis` 需要下载 NSIS 工具，先设 `HTTPS_PROXY=http://127.0.0.1:7890` 再打包。

对比 Electron：`node_modules/electron/dist` 357MB，便携包压缩后仍 100MB+。

## 窗口与打开策略

- **应用内打开**（按钮 / Ctrl+O / 最近文件 / 新建）：留在当前窗口。有未保存更改时三选一：保存 / 不保存 / 取消。
- **外部打开**（拖入窗口 / 资源管理器右键“打开方式” / 双击关联文件 / 第二实例）：新建独立 OS 窗口，保留原窗口，方便并排对比；不做应用内标签页。
- 空窗口（没有打开文件、未修改）拖入文件时原地打开，避免留下空窗口。
- 自动保存按窗口分文件（`autosave-<label>.json`），窗口 label 带进程 ID，避免跨会话把旧稿恢复进新窗口。
- 每个窗口独立的 dirty / 关闭确认状态。

## 打印与预览（2026-11-03 修）

- 打印预览按内容高度自动分页，不再只按分页符切页；实测 18,598 字多段文档：PDF 18 页、预览 18 页，完全一致。
- 预览工具栏新增纸张（A4/A5/Letter）和方向选择，直接改当前文档页面设置并重排。
- 注意：单个超长段落（一整段几十万字、没有分段）暂未按行拆分，预览会保留为一个块；PDF/打印引擎本身仍会按行自动分页。
- 三选一保存对话框按 `MessageDialogResult::Custom(按钮文字)` 映射（rfd 在 Windows 上返回自定义标签，不是 Yes/No）。
- 外部打开加了同路径 1.5 秒去重、最多 20 个窗口、渲染层 1.2 秒重入保护；Tauri 下禁用 DOM 拖放处理器，避免和原生拖放重复触发。

## 对话框层级

原生对话框（确认/打开/保存/导出 PDF）必须用 `parent(&window)` / `set_parent(&window)` 挂到主窗口，弹窗前对窗口 `unminimize()` + `set_focus()`。这样对话框只压在应用窗口之上，不需要也不应该用 `alwaysOnTop`（全局置顶）。拖放打开文件时窗口可能刚失去焦点，这一步尤其重要。

## macOS 实现要点（v1.0.1）

- **配置**：macOS 专属配置全部放 `tauri.macos.conf.json`（`minimumSystemVersion` 13.0、`signingIdentity: "-"`、category、docx / txt 文件关联、`zh-Hans.lproj/InfoPlist.strings` 让菜单栏和程序坞显示「简写」）；通用 `tauri.conf.json` 除两个平台共用的版本号外没有 macOS 相关内容。文件关联不能写进通用配置，否则 Windows 安装包行为会变。
- **菜单栏**：`build_app_menu` 整体在 `#[cfg(target_os = "macos")]` 里。撤销 / 重做必须是自定义菜单项发 `menu-command`，用系统的 `undo:` / `redo:` 会绕过 TipTap 的历史记录。菜单 id 由 Rust `emit_to(当前焦点窗口, "menu-command", id)` 发给渲染层，渲染层用 `onMenuCommand` 分发到已有函数。
- **退出**：⌘Q 是自定义菜单项（不是 `PredefinedMenuItem::quit`）：置 `quitting` 后按队列逐个 `close()`，复用 CloseRequested 的保存询问；渲染层选「取消」时调 `close_cancelled` 清掉 `quitting`；最后一个窗口 `Destroyed` 且 `quitting` 才 `app.exit(0)`。
- **关掉最后一个窗口不退出**：`RunEvent::ExitRequested { code: None }` 且 `!quitting` 时 `api.prevent_exit()`；`RunEvent::Reopen` 优先把已最小化 / 隐藏的窗口 `unminimize + show + set_focus`，一个窗口都没有才新建。
- **访达打开**：`RunEvent::Opened { urls }` 只处理 file URL，扩展名过滤和 argv 共用同一个函数；主窗口还没 ready 时塞进 `pending_open`，去重逻辑和 `open_external` 共用。
- **快捷键**：渲染层 `isMac = /Mac/.test(navigator.userAgent)`，`isMod` 在 Mac 上只认 `metaKey`，Ctrl 组合键一律放行；替换 ⌥⌘F 必须用 `e.code === 'KeyF'` 判断（按住 Option 时 `e.key` 会变成 `ƒ`），而且要放在 `altKey` 早退之前。
- **打印 / PDF**：PDF 导出在 `with_webview` 里拿 `WKWebView` 和 `NSWindow`，`NSPrintInfo` 的纸张按 `pageMetrics()` 的厘米换算，四边 margin 设 0（WebKit 遵守 CSS `@page` margin，不会双重边距）；view 的 frame 要手动设成 webview 的 bounds，必须用异步的 `runOperationModalForWindow:`（同步的 `runOperation` 在 WKWebView 上输出空白页）。完成判定 = 临时文件大小连续 300ms 不变 + 文件尾 1KB 内有 `%%EOF`，之后再 `rename` 覆盖目标文件。
- **分页一致性**：WKWebView 打印时把 CSS px→pt 的系数当成 0.801（正常 0.75），正文被放大约 7%，PDF 会比预览多 1 页。修法是 Mac 上 `applyPageSetup` 写入 `--print-content-width`（纸宽减左右页边距），`@media print .paper` 宽度用 `var(--print-content-width, 100%)`；Windows 上没有这个变量，行为不变。
- **字体**：`FONTS` 每一项第一个名字必须保持是 Windows 字体名（docx.js 取第一个名字写进 DOCX），Mac 字体名追加在后面；`style.css` 的字体栈前置 `-apple-system, "PingFang SC"`。导入的 DOCX 若只写了一个字体名，渲染时补回退字体，导出不变。
- **WebKit 兼容**：esbuild target 改成 `chrome130,safari16`；`.dialog::backdrop` 补 `-webkit-backdrop-filter`，`.select` 补 `-webkit-appearance: none`。`zoom`、`::-webkit-scrollbar`、`<dialog>`、`:has()` 在 Safari 16 上都可用，不用换写法。

## 已知风险

- 打印和分页对 CSS 很敏感：改动 `@page`、`--print-content-width`、行高或字号后，**必须同时复核 Windows 和 macOS 的页数**（selftest 里 `longPdfPages` 必须等于 `previewPages`，CI 的 `REQUIRE_PDF=1` 会卡这一项）。
- `tao` 只实现了 `applicationWillTerminate`，没有实现 `applicationShouldTerminate`：从 Dock 图标右键「退出」、注销、关机时进程被直接终止，不走保存流程（已写进 README 已知限制）。⌘Q 走自定义菜单项，是安全的。
- muda 的加速键只认物理按键码，「帮助 ⌘?」在菜单里只能写成 `CmdOrCtrl+Shift+/`，显示为 ⇧⌘/（功能与 ⌘? 相同）。要真正显示 ⌘? 得用 objc2 直接改 `NSMenuItem`。
- macOS 包是 ad-hoc 签名，没有公证；要免掉首次打开的「仍要打开」步骤，需要 Developer ID + notarization，并把 CI 的签名配置补上。
- macOS 无法从 Windows 交叉编译，真实构建和运行只能靠 GitHub Actions `macos-latest` 或朋友的 Mac；本机 `mac-check` 只查类型，查不出链接和运行期问题。
- `renderer/bundle.js` 仍由 esbuild 生成，构建前需 `npm run build`。
