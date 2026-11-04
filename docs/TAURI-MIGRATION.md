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
| exportPdf / printToPDF | export-pdf / print-to-pdf | 阶段 2（原生实现） |
| onSaveBeforeClose | save-before-close 事件 | 同名事件 |
| onOpenFile | open-file-path 事件 | 同名事件（拖放 + argv + 单实例） |
| notifyReady | renderer-ready | renderer_ready |

## 迁移阶段

1. **Shell + 文件 IO（已完成）**：Tauri 窗口加载现有 renderer，编辑、文件读写、自动保存、查找替换、拖放/打开方式、单实例均已接好。
2. **打印 / PDF（Windows 已完成基础版）**：WebView2 `ICoreWebView2_7::PrintToPdf` + `ICoreWebView2Environment6::CreatePrintSettings`，纸张尺寸/边距取渲染层 `@page` 的厘米值；普通打印先走 `window.print()` 系统面板。页码/份数待接 `ICoreWebView2PrintSettings2`。
3. **macOS**：WKWebView `createPDF` + `NSPrintOperation`；字体回退、Cmd 快捷键、`open-file`（RunEvent::Opened）、签名/公证。
4. **发布**：用 Tauri 打包（NSIS/MSI/dmg），保留 Electron 版本作为回退通道，直到功能对齐。

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

## 已知风险

- WebView2 的打印设置对 CSS `@page` 的支持与 Electron `preferCSSPageSize` 不同，PDF 分页/边距需要单独调。
- 预览缩放用了 CSS `zoom`，需要在 WKWebView 实测。
- macOS 无法从 Windows 交叉编译，需要 Mac 或 GitHub Actions `macos-latest`。
- `renderer/bundle.js` 仍由 esbuild 生成，构建前需 `npm run build`。
