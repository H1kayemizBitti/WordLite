// 预加载脚本：以最小面积暴露 API 给渲染进程
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wordlite', {
  appInfo: { name: '简写', version: '0.1.0' },
  file: {
    showOpenDialog: (filters) => ipcRenderer.invoke('show-open-dialog', { filters }),
    showSaveDialog: (defaultPath, filters) => ipcRenderer.invoke('show-save-dialog', { defaultPath, filters }),
    readFile: (filePath, binary = false) => ipcRenderer.invoke('read-file', { filePath, binary }),
    writeFile: (filePath, data, binary = false) => ipcRenderer.invoke('write-file', { filePath, data, binary }),
    readAutosave: () => ipcRenderer.invoke('read-autosave'),
    writeAutosave: (payload) => ipcRenderer.invoke('write-autosave', payload),
    clearAutosave: () => ipcRenderer.invoke('clear-autosave'),
    confirmAction: (message) => ipcRenderer.invoke('confirm-action', message),
    setDocumentState: (dirty, fileName) => ipcRenderer.send('document-state', { dirty, fileName }),
    closeAfterSave: () => ipcRenderer.send('close-after-save'),
    print: (options = {}) => ipcRenderer.send('print-document', options),
    exportPdf: (defaultPath) => ipcRenderer.invoke('export-pdf', defaultPath),
    printToPDF: () => ipcRenderer.invoke('print-to-pdf'),
    onSaveBeforeClose: (callback) => ipcRenderer.on('save-before-close', callback)
  }
})
