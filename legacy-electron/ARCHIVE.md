# 旧版 Electron 源码（归档，不再维护）

这是简写 WordLite 的 **Electron v0.1.0** 源码，保留用于对照和回滚。

- 新版在仓库根目录，使用 **Tauri 2 + WebView2 / WKWebView**。
- 这个目录不会跟随新版功能更新，也不建议再用来处理正式文档。
- 归档基于提交 `8e54fdb`，并应用了 `electron-final-changes-2026-11-03.patch` 的最终 Electron 改动。

## 运行

```bash
cd legacy-electron
npm install
npm start
```

需要 Node.js 和 Electron 支持的桌面环境。`npm run smoke` 可跑原有 smoke 检查。
