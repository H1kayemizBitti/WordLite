// 简写 WordLite - Electron 主进程
// 本软件完全离线：拦截一切网络请求，仅放行剪贴板读取权限
const { app, BrowserWindow, Menu, session, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

const isSmoke = process.argv.includes('--smoke')
const autosaveFile = () => path.join(app.getPath('userData'), 'autosave.json')

async function clearAutosave () {
  try {
    await fs.promises.unlink(autosaveFile())
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

ipcMain.handle('show-open-dialog', async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: options.filters
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('show-save-dialog', async (event, options) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const requested = options.defaultPath || '未命名文档.docx'
  const defaultPath = path.isAbsolute(requested) ? requested : path.join(app.getPath('documents'), requested)
  const result = await dialog.showSaveDialog(win, {
    title: '另存为',
    defaultPath,
    filters: options.filters
  })
  return result.canceled ? null : result.filePath
})

// 文本文件常见编码：UTF-8（含 BOM）、UTF-16LE/BE（记事本“Unicode”）、GBK（中文 Windows 旧文件）
function decodeText (buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.toString('utf8', 3)
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(buffer.subarray(2))
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(buffer.subarray(2))
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    try {
      return new TextDecoder('gbk').decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

ipcMain.handle('read-file', async (_event, { filePath, binary }) => {
  const data = await fs.promises.readFile(filePath)
  return binary ? data.toString('base64') : decodeText(data)
})

ipcMain.handle('write-file', async (_event, { filePath, data, binary }) => {
  await fs.promises.writeFile(filePath, binary ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8'))
})

ipcMain.handle('read-autosave', async () => {
  try {
    return JSON.parse(await fs.promises.readFile(autosaveFile(), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
})

ipcMain.handle('write-autosave', async (_event, payload) => {
  await fs.promises.mkdir(path.dirname(autosaveFile()), { recursive: true })
  await fs.promises.writeFile(autosaveFile(), JSON.stringify(payload), 'utf8')
})

ipcMain.handle('clear-autosave', clearAutosave)

ipcMain.handle('confirm-action', async (event, message) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showMessageBox(win, {
    type: 'warning',
    message,
    buttons: ['是', '否'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return result.response === 0
})

ipcMain.on('document-state', (event, { dirty, fileName }) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.wordliteDirty = !!dirty
  win.setTitle(`${dirty ? '*' : ''}${fileName} - 简写`)
})

ipcMain.on('close-after-save', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  win.wordliteAllowClose = true
  win.close()
})

// 打印页码输入是 1 起的“1-3,5”，Electron 要求 0 起的闭区间
function parsePageRanges (text) {
  if (!text || typeof text !== 'string') return undefined
  const ranges = []
  for (const part of text.split(',')) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/)
    if (!match) continue
    const from = Number(match[1])
    const to = match[2] ? Number(match[2]) : from
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) continue
    ranges.push({ from: from - 1, to: to - 1 })
  }
  return ranges.length ? ranges : undefined
}

function printToPdf (win) {
  // 页面尺寸与边距由渲染进程写入 @page；preferCSSPageSize 保证打印/PDF 与界面一致
  return win.webContents.printToPDF({
    preferCSSPageSize: true,
    printBackground: true
  })
}

ipcMain.on('print-document', (event, options = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return
  const printOptions = { printBackground: true }
  const copies = Math.round(Number(options.copies))
  if (Number.isInteger(copies) && copies >= 1) printOptions.copies = Math.min(99, copies)
  const pageRanges = parsePageRanges(options.pageRanges)
  if (pageRanges) printOptions.pageRanges = pageRanges
  win.webContents.print(printOptions, (success, failureReason) => {
    if (!success && failureReason) console.error('[print]', failureReason)
  })
})

ipcMain.handle('print-to-pdf', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('窗口不可用')
  const data = await printToPdf(win)
  return data.toString('base64')
})

ipcMain.handle('export-pdf', async (event, defaultPath) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) throw new Error('窗口不可用')
  const result = await dialog.showSaveDialog(win, {
    defaultPath,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }]
  })
  if (result.canceled || !result.filePath) return { saved: false }
  const filePath = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`
  const data = await printToPdf(win)
  await fs.promises.writeFile(filePath, data)
  return { saved: true, path: filePath }
})

// 断网 + 权限收紧
function lockdown () {
  const ses = session.defaultSession
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] },
    (_details, callback) => callback({ cancel: true })
  )
  const allowed = ['clipboard-read', 'clipboard-sanitize']
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.includes(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => allowed.includes(permission))
}

function createWindow () {
  const win = new BrowserWindow({
    width: 1160,
    height: 860,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    title: '未命名文档 - 简写',
    show: !isSmoke,           // 冒烟测试时不弹窗
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  let fatal = null
  win.webContents.on('render-process-gone', () => { fatal = 'render-process-gone' })

  win.on('close', async (event) => {
    if (isSmoke || !win.wordliteDirty || win.wordliteAllowClose) return
    event.preventDefault()
    if (win.wordliteClosePrompt) return
    win.wordliteClosePrompt = true
    try {
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        message: '当前文档有未保存的更改。',
        detail: '是否在关闭前保存？',
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
        noLink: true
      })
      if (result.response === 0) win.webContents.send('save-before-close')
      else if (result.response === 1) {
        await clearAutosave()
        win.wordliteAllowClose = true
        win.close()
      }
    } finally {
      win.wordliteClosePrompt = false
    }
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: isSmoke ? { smoke: '1' } : {}
  })

  if (isSmoke) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const ok = await win.webContents.executeJavaScript(
          "!!(window.wordlite && document.querySelector('.ProseMirror'))"
        )
        console.log('[smoke] editor mounted:', ok, fatal || '')
        app.exit(ok && !fatal ? 0 : 1)
      }, 1500)
    })
    setTimeout(() => { console.log('[smoke] timeout'); app.exit(2) }, 20000)
  }
  return win
}

app.whenReady().then(() => {
  lockdown()
  Menu.setApplicationMenu(null) // 菜单栏交给界面按钮，快捷键由 Chromium 原生支持
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
