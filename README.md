<p align="center">
  <img src="assets/icon.png" width="112" alt="简写图标">
</p>

<h1 align="center">简写 WordLite</h1>

<p align="center">一个安静、离线、专注写字的 Windows 桌面工具。</p>

<p align="center"><code>Windows 10/11</code> · <code>Electron 45</code> · <code>MIT</code></p>

文件只在本地读写，不上传、不联网、不需要账号。

![简写界面](docs/screenshot.png)

## 功能

- DOCX / TXT 打开与保存
- 标题、字体、字号、颜色、高亮、加粗、斜体、下划线、删除线、上下标
- 段落对齐、缩进、行距、段前段后间距、字符间距、格式刷
- 表格插入、列宽拖动、合并/拆分单元格、单元格底色、边框宽度和颜色
- 图片插入、缩放、左/中/右对齐、左右文字环绕、裁剪、更换、删除
- 页面尺寸、方向、页边距、页面背景
- 打印预览、页码范围、份数、导出 PDF
- 最近文件、自动保存和崩溃恢复
- 完整快捷键、设置、帮助

## 开发

环境：

- Windows 10/11
- Node.js 22 或更高版本
- npm

```bash
npm install
npm start
```

`npm start` 会先构建 `renderer/bundle.js`，再启动应用。

常用命令：

```bash
npm run build   # 只构建渲染进程 bundle
npm run smoke   # 构建并做启动冒烟测试
```

本机如果设置了 `ELECTRON_RUN_AS_NODE`，直接运行 electron 可能没有窗口；使用项目根目录的 `启动简写.bat`，它会先清掉这个变量。

## 打包便携版

双击：

```text
打包便携版.bat
```

或运行：

```bash
node tools/package-portable.cjs
```

会生成：

```text
dist/WordLite-<版本>-portable.zip
```

这是免安装版，解压后双击 `WordLite.exe` 即可。压缩包必须完整分发，不能只发 exe，因为还需要同目录的 DLL 和 `resources`。

注意：

- Electron 应用体积较大，压缩包约 150 MB
- 默认没有代码签名，Windows 首次运行可能提示“已保护你的电脑”
- 如果目标目录被资源管理器或旧的 WordLite 进程占用，打包脚本会自动改用带时间戳的新目录，不会卡死
- 暂未配置自定义图标和安装程序；需要时可在 `tools/` 中接入 electron-builder

## 目录结构

```text
main.js                 Electron 主进程、窗口、文件读写、打印/PDF IPC
preload.js              contextBridge 安全 API
renderer/
  app.js                编辑器、工具栏、文件、打印、设置
  docx.js               DOCX 导入导出
  extensions.js         TipTap 自定义扩展
  index.html            界面结构
  style.css             界面样式
  bundle.js             构建产物（不提交，npm run build 生成）
tools/
  package-portable.cjs  便携版打包脚本
启动简写.bat            开发环境启动
打包便携版.bat          便携版一键打包
```

## 安全设计

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- 渲染进程只通过 preload 暴露最小 API
- 拦截全部 http/https/ws/wss 请求
- 仅放行剪贴板读取相关权限

## 已知限制

- 打印/PDF 分页按分页符计算，复杂段落的自动换行分页和屏幕预览可能不完全一致
- DOCX 导入会简化部分复杂对象（文本框、嵌套表格、复杂域等）
- 图片文字环绕目前支持左右浮动
- 打包版未签名，公开分发前建议配置代码签名

## License

MIT
