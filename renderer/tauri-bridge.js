// Tauri 环境下的最小 Electron preload 兼容层。
// Electron 里没有 window.__TAURI__，本文件直接退出，不影响原有 preload。
(() => {
  const tauri = window.__TAURI__
  if (!tauri || window.wordlite) return

  const currentWindow = tauri.webviewWindow?.getCurrentWebviewWindow?.()
  const isMac = /Mac/.test(navigator.userAgent)

  // Tauri 的 reject 可能是字符串，统一转成 Error，状态栏才能显示系统错误文字
  const invoke = (cmd, args) => tauri.core.invoke(cmd, args).catch((error) => {
    throw error instanceof Error ? error : new Error(String(error))
  })

  // 从渲染层写好的 @page 规则里取纸张尺寸和页边距（cm），交给原生打印设置
  const pageMetrics = () => {
    const rule = document.querySelector('#printPageStyle')?.textContent || ''
    const size = rule.match(/size:\s*([\d.]+)cm\s+([\d.]+)cm/)
    const margin = rule.match(/margin:\s*([\d.]+)cm\s+([\d.]+)cm\s+([\d.]+)cm\s+([\d.]+)cm/)
    return {
      pageWidth: size ? Number(size[1]) : 21,
      pageHeight: size ? Number(size[2]) : 29.7,
      marginTop: margin ? Number(margin[1]) : 2.54,
      marginRight: margin ? Number(margin[2]) : 3.18,
      marginBottom: margin ? Number(margin[3]) : 2.54,
      marginLeft: margin ? Number(margin[4]) : 3.18
    }
  }

  const file = {
    showOpenDialog: (filters) => invoke('show_open_dialog', { filters }),
    showSaveDialog: (defaultPath, filters) => invoke('show_save_dialog', { defaultPath, filters }),
    readFile: (filePath, binary = false) => invoke('read_file', { filePath, binary }),
    // Tauri 的拖放是原生事件，DOM File 拿不到磁盘路径；返回 null 走 onOpenFile 通道
    getPathForFile: () => null,
    writeFile: (filePath, data, binary = false) => invoke('write_file', { filePath, data, binary }),
    readAutosave: () => invoke('read_autosave'),
    writeAutosave: (payload) => invoke('write_autosave', { payload }),
    clearAutosave: () => invoke('clear_autosave'),
    listOrphanAutosaves: () => invoke('list_orphan_autosaves'),
    restoreOrphanAutosave: (label) => invoke('restore_orphan_autosave', { label }),
    confirmAction: (message) => invoke('confirm_action', { message }),
    confirmSaveChanges: () => invoke('confirm_save_changes'),
    openInNewWindow: (filePath) => invoke('open_external', { path: filePath }),
    // Mac 的 ⌘N：开一个新的空窗口，当前窗口内容不动（Windows 上渲染层不会调用）
    newWindow: () => invoke('new_window'),
    setDocumentState: (dirty, fileName) => invoke('set_document_state', { dirty, fileName }),
    closeAfterSave: () => invoke('close_after_save'),
    // 关闭确认里选了「取消」：通知 Rust 中止退出流程；Windows 上该命令什么也不做
    closeCancelled: () => invoke('close_cancelled'),
    print: () => invoke('print_document'),
    // 打印面板打开期间由 Rust 挡住窗口关闭；渲染层用这个标志告诉原生层
    setPrintingMode: (printing) => invoke('set_printing_mode', { printing }),
    exportPdf: (defaultPath) => invoke('export_pdf', { defaultPath, page: pageMetrics() }),
    // Mac：屏幕分页逐页 createPDF + PDFKit 合并（页眉页脚和正文不经过打印排版）
    exportPdfCapture: (defaultPath, rects, targetPath) =>
      invoke('export_pdf_capture', { defaultPath, rects, targetPath }),
    printToPDF: () => invoke('print_to_pdf', { page: pageMetrics() }),
    onSaveBeforeClose: (callback) => {
      currentWindow?.listen?.('save-before-close', () => callback())
    },
    // 拖放打开：Tauri 原生拖放事件直接给出路径；“打开方式”由 Rust 端发 open-file-path。
    // 是否新开窗口由渲染层根据当前是否已有文档决定（见 app.js）。
    onOpenFile: (callback) => {
      if (currentWindow?.onDragDropEvent) {
        currentWindow.onDragDropEvent((event) => {
          if (event.payload?.type !== 'drop') return
          for (const path of event.payload.paths || []) callback(path)
        })
      }
      currentWindow?.listen?.('open-file-path', (event) => callback(event.payload))
    },
    // 拖放的原始事件：图片要按松手位置插入正文，所以除了路径还得拿到窗口内坐标。
    // 坐标是物理像素，转成 CSS 像素再交给渲染层
    onDragDrop: (callback) => {
      if (!currentWindow?.onDragDropEvent) return
      const ratio = window.devicePixelRatio || 1
      currentWindow.onDragDropEvent((event) => {
        if (event.payload?.type !== 'drop') return
        const position = event.payload.position || {}
        callback({
          paths: event.payload.paths || [],
          x: (position.x || 0) / ratio,
          y: (position.y || 0) / ratio
        })
      })
    },
    // macOS 菜单栏：Rust 端把菜单 id 发给当前焦点窗口，这里按约定接收
    onMenuCommand: (callback) => {
      currentWindow?.listen?.('menu-command', (event) => callback(event.payload))
    },
    // 输入法组合状态上报给原生层：组合中的右键必须在那之前被吞掉，否则
    // WKWebView 会把没上屏的拼音就地摊成字母（§6.1 / §6.2）。失败不吵人
    setImeComposing: (composing) => {
      invoke('set_ime_composing', { composing }).catch(() => {})
    },
    notifyReady: () => invoke('renderer_ready')
  }

  window.wordlite = {
    appInfo: {
      name: '简写',
      version: '1.2.0',
      label: currentWindow?.label || 'main'
    },
    // 渲染层用它决定快捷键和文案：'mac' 或 'win'
    platform: isMac ? 'mac' : 'win',
    file
  }
})()
