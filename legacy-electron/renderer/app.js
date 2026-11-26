// 简写 WordLite - 渲染进程主逻辑（原生 JS，无框架）
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextAlign } from '@tiptap/extension-text-align'
import { Underline } from '@tiptap/extension-underline'
import { Highlight } from '@tiptap/extension-highlight'
import { TextStyle } from '@tiptap/extension-text-style'
import { Color } from '@tiptap/extension-color'
import { FontFamily } from '@tiptap/extension-font-family'
import { TableRow } from '@tiptap/extension-table-row'
import { CharacterCount, Placeholder } from '@tiptap/extensions'
import { EditorState } from '@tiptap/pm/state'
import {
  Indent,
  LineHeight,
  FontSize,
  LetterSpacing,
  ParagraphSpacing,
  Superscript,
  Subscript,
  PlainTextInput,
  PageBreak,
  WordImage,
  WordTable,
  WordTableView,
  WordTableCell,
  WordTableHeader,
  StrikeWithShortcut
} from './extensions.js'
import { docxBase64ToJSON, jsonToDocxBase64 } from './docx.js'

/* ---------------- 常量 ---------------- */

const FONTS = [
  { label: '等线', value: 'DengXian, 等线, "Microsoft YaHei", 微软雅黑, sans-serif' },
  { label: '宋体', value: 'SimSun, 宋体, serif' },
  { label: '黑体', value: 'SimHei, 黑体, sans-serif' },
  { label: '仿宋', value: 'FangSong, 仿宋, SimSun, serif' },
  { label: '楷体', value: 'KaiTi, 楷体, serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", 微软雅黑, sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: 'Courier New', value: '"Courier New", monospace' }
]

const SIZES = ['8', '9', '10', '10.5', '11', '12', '14', '16', '18', '20', '22', '24', '26', '28', '36', '48', '72']

const COLORS = [
  '#000000', '#7f7f7f', '#c00000', '#ff0000', '#ed7d31',
  '#ffc000', '#ffff00', '#70ad47', '#00b050', '#00b0f0',
  '#0070c0', '#002060', '#7030a0', '#ffffff'
]

const HIGHLIGHTS = [
  '#ffff00', '#00ff00', '#00ffff', '#ff00ff',
  '#0000ff', '#ff0000', '#000080', '#008000'
]

const PAGE_SIZES = {
  a4: { width: 21, height: 29.7 },
  a5: { width: 14.8, height: 21 },
  letter: { width: 21.59, height: 27.94 }
}

const PAGE_MARGINS = {
  normal: { top: 2.54, right: 3.18, bottom: 2.54, left: 3.18 },
  narrow: { top: 1.27, right: 1.27, bottom: 1.27, left: 1.27 },
  wide: { top: 2.54, right: 5.08, bottom: 2.54, left: 5.08 }
}

const SETTINGS_KEY = 'wordlite.settings.v1'
const RECENT_KEY = 'wordlite.recent.v1'
const MAX_RECENT = 8

const DEFAULT_SETTINGS = {
  fontFamily: FONTS[0].value,
  fontSize: '11',
  lineHeight: '1.6',
  pageSize: 'a4',
  pageOrientation: 'portrait',
  pageMargin: 'normal',
  autosaveMinutes: 2
}

const fileApi = window.wordlite.file
const isSmoke = new URLSearchParams(location.search).has('smoke')
let currentPath = null
let currentFileName = '未命名文档'
let currentFormat = 'docx'
let dirty = false
let loadingDocument = false
let saveInProgress = false
let statusTimer = null
let autosaveTimer = null
let formatPainter = null
let recentFiles = []

const clamp = (value, min, max, fallback = min) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

function storageRead (key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch {
    return fallback
  }
}

function storageWrite (key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 本地存储写入失败不影响编辑
  }
}

function normalizeSettings (input = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) }
  if (!FONTS.some((font) => font.value === settings.fontFamily)) settings.fontFamily = DEFAULT_SETTINGS.fontFamily
  if (!SIZES.includes(String(settings.fontSize))) settings.fontSize = DEFAULT_SETTINGS.fontSize
  settings.fontSize = String(settings.fontSize)
  settings.lineHeight = String(clamp(settings.lineHeight, 0.8, 3, Number(DEFAULT_SETTINGS.lineHeight)))
  if (!PAGE_SIZES[settings.pageSize]) settings.pageSize = DEFAULT_SETTINGS.pageSize
  if (!['portrait', 'landscape'].includes(settings.pageOrientation)) settings.pageOrientation = DEFAULT_SETTINGS.pageOrientation
  if (!PAGE_MARGINS[settings.pageMargin]) settings.pageMargin = DEFAULT_SETTINGS.pageMargin
  settings.autosaveMinutes = Math.round(clamp(settings.autosaveMinutes, 0, 60, DEFAULT_SETTINGS.autosaveMinutes))
  return settings
}

function normalizePageSetup (input = {}) {
  const setup = { ...input }
  const size = PAGE_SIZES[setup.size] ? setup.size : 'a4'
  const orientation = setup.orientation === 'landscape' ? 'landscape' : 'portrait'
  const preset = PAGE_MARGINS[setup.margin] ? setup.margin : (setup.margin === 'custom' ? 'custom' : 'normal')
  const base = PAGE_MARGINS[preset] || PAGE_MARGINS.normal
  const source = setup.margins && typeof setup.margins === 'object' ? setup.margins : base
  const margins = {}
  for (const side of ['top', 'right', 'bottom', 'left']) {
    margins[side] = Math.round(clamp(source[side], 0, 10, base[side]) * 100) / 100
  }
  const background = /^#[0-9a-f]{6}$/i.test(setup.background || '') ? setup.background.toLowerCase() : '#ffffff'
  return { size, orientation, margin: preset, margins, background }
}

function pageSetupFromSettings () {
  return normalizePageSetup({
    size: settings.pageSize,
    orientation: settings.pageOrientation,
    margin: settings.pageMargin,
    margins: PAGE_MARGINS[settings.pageMargin],
    background: '#ffffff'
  })
}

let settings = normalizeSettings(storageRead(SETTINGS_KEY, {}))
let pageSetup = pageSetupFromSettings()

function loadRecentFiles () {
  const value = storageRead(RECENT_KEY, [])
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item.path === 'string').slice(0, MAX_RECENT)
    : []
}

recentFiles = loadRecentFiles()

/* ---------------- 编辑器 ---------------- */

const editorExtensions = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] }, underline: false, strike: false }),
  StrikeWithShortcut,
  Underline,
  TextStyle,
  FontFamily,
  FontSize,
  LetterSpacing,
  Color.configure({ types: ['textStyle'] }),
  Highlight.configure({ multicolor: true }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  Indent,
  LineHeight,
  ParagraphSpacing,
  Superscript,
  Subscript,
  WordImage.configure({
    allowBase64: true,
    resize: { enabled: true, minWidth: 40, minHeight: 30, alwaysPreserveAspectRatio: false }
  }),
  PageBreak,
  WordTable.configure({ resizable: true, cellMinWidth: 40, lastColumnResizable: true, View: WordTableView }),
  TableRow,
  WordTableHeader,
  WordTableCell,
  CharacterCount,
  Placeholder.configure({ placeholder: '开始输入…' }),
  PlainTextInput
]

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: editorExtensions,
  content: '<p></p>',
  onSelectionUpdate: syncToolbar,
  onUpdate: handleEditorUpdate
})

/* ---------------- 选项卡 ---------------- */

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab))
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'))
    document.querySelector(`#panel-${tab.dataset.tab}`).classList.add('active')
    closePopovers()
  })
})

/* ---------------- 下拉框填充 ---------------- */

const fontFamilySel = document.querySelector('#fontFamily')
const fontSizeSel = document.querySelector('#fontSize')

FONTS.forEach((f) => fontFamilySel.add(new Option(f.label, f.value)))
fontFamilySel.add(new Option('字体：默认', ''), 0)
fontFamilySel.value = ''

SIZES.forEach((s) => fontSizeSel.add(new Option(s, s)))
fontSizeSel.add(new Option('字号：默认', ''), 0)
fontSizeSel.value = ''

const settingsFontSel = document.querySelector('#settingsFont')
const settingsFontSizeSel = document.querySelector('#settingsFontSize')
FONTS.forEach((f) => settingsFontSel.add(new Option(f.label, f.value)))
SIZES.forEach((s) => settingsFontSizeSel.add(new Option(s, s)))

fontFamilySel.addEventListener('change', () => {
  const chain = editor.chain().focus()
  if (fontFamilySel.value) chain.setFontFamily(fontFamilySel.value)
  else chain.unsetFontFamily()
  chain.run()
})

fontSizeSel.addEventListener('change', () => {
  const chain = editor.chain().focus()
  if (fontSizeSel.value) chain.setFontSize(`${fontSizeSel.value}pt`)
  else chain.unsetFontSize()
  chain.run()
})

document.querySelector('#blockStyle').addEventListener('change', (e) => {
  const chain = editor.chain().focus()
  if (e.target.value === 'paragraph') chain.setParagraph()
  else chain.setHeading({ level: Number(e.target.value.slice(1)) })
  chain.run()
})

document.querySelector('#lineHeight').addEventListener('change', (e) => {
  editor.chain().focus().setLineHeight(e.target.value || null).run()
})

document.querySelector('#letterSpacing').addEventListener('change', (e) => {
  const value = e.target.value === '' ? null : clamp(e.target.value, -2, 20, 0)
  const chain = editor.chain().focus()
  if (value === null) chain.unsetLetterSpacing()
  else chain.setLetterSpacing(value)
  chain.run()
})

document.querySelector('#spacingBefore').addEventListener('change', (e) => {
  editor.chain().focus().setBlockSpacing({ spacingBefore: e.target.value === '' ? null : e.target.value }).run()
})

document.querySelector('#spacingAfter').addEventListener('change', (e) => {
  editor.chain().focus().setBlockSpacing({ spacingAfter: e.target.value === '' ? null : e.target.value }).run()
})

/* ---------------- 工具按钮 ---------------- */

// chain 级命令映射
const chainCommands = {
  bold: (c) => c.toggleBold(),
  italic: (c) => c.toggleItalic(),
  underline: (c) => c.toggleUnderline(),
  strike: (c) => c.toggleStrike(),
  superscript: (c) => c.toggleSuperscript(),
  subscript: (c) => c.toggleSubscript(),
  alignLeft: (c) => c.setTextAlign('left'),
  alignCenter: (c) => c.setTextAlign('center'),
  alignRight: (c) => c.setTextAlign('right'),
  alignJustify: (c) => c.setTextAlign('justify'),
  bulletList: (c) => c.toggleBulletList(),
  orderedList: (c) => c.toggleOrderedList(),
  indent: (c) => c.indent(),
  outdent: (c) => c.outdent(),
  addRowAfter: (c) => c.addRowAfter(),
  addColumnAfter: (c) => c.addColumnAfter(),
  deleteRow: (c) => c.deleteRow(),
  deleteColumn: (c) => c.deleteColumn(),
  deleteTable: (c) => c.deleteTable(),
  mergeCells: (c) => c.mergeCells(),
  splitCell: (c) => c.splitCell()
}

document.querySelectorAll('.tbtn[title], .select[title]').forEach((el) => {
  el.setAttribute('aria-label', el.title)
})

document.querySelector('#ribbon').addEventListener('click', (e) => {
  const btn = e.target.closest('.tbtn')
  if (!btn || btn.id === 'btnFontColor' || btn.id === 'btnHighlight') return
  const cmd = btn.dataset.cmd
  if (!cmd) return

  if (cmd === 'formatPainter') {
    if (formatPainter) {
      formatPainter = null
      showStatus('已取消格式刷')
    } else {
      captureFormat()
    }
    syncToolbar()
    return
  }

  if (chainCommands[cmd]) {
    chainCommands[cmd](editor.chain().focus()).run()
  } else if (cmd === 'clearFormat') {
    editor.chain().focus()
      .unsetBold()
      .unsetItalic()
      .unsetUnderline()
      .unsetStrike()
      .unsetCode()
      .unsetLink()
      .unsetColor()
      .unsetHighlight()
      .unsetSuperscript()
      .unsetSubscript()
      .unsetLetterSpacing()
      .setLineHeight(null)
      .setBlockSpacing({ spacingBefore: null, spacingAfter: null })
      .setIndentTo(0)
      .run()
  } else if (cmd === 'selectAll') {
    editor.chain().focus().selectAll().run()
  } else if (cmd === 'cut' || cmd === 'copy') {
    editor.commands.focus()
    document.execCommand(cmd) // 走 Chromium 原生剪贴板
  } else if (cmd === 'paste') {
    pasteFromClipboard()
  } else if (cmd === 'insertTable') {
    editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
  } else if (cmd === 'insertPageBreak') {
    insertPageBreak()
  } else if (cmd === 'insertDate') {
    const date = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    editor.chain().focus().insertContent(date).run()
  } else if (cmd === 'insertImage') {
    insertImage()
  } else if (cmd === 'editImage') {
    openImageDialog()
  }
  syncToolbar()
})

function insertPageBreak () {
  const chain = editor.chain().focus()
  if (editor.state.selection.node) chain.setTextSelection(editor.state.selection.to)
  chain.insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }]).run()
}

async function pasteFromClipboard () {
  editor.commands.focus()
  try {
    const text = await navigator.clipboard.readText()
    if (text) editor.chain().focus().insertContent(text).run()
  } catch {
    // 剪贴板读取被拒时退化为 Chromium 原生粘贴
    document.execCommand('paste')
  }
}

async function insertImage () {
  const filePath = await fileApi.showOpenDialog([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }])
  if (!filePath) return
  try {
    const data = await fileApi.readFile(filePath, true)
    const extension = filePath.split('.').pop().toLowerCase()
    const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`
    editor.chain().focus().setImage({ src: `data:${mime};base64,${data}`, alt: fileNameFromPath(filePath) }).run()
  } catch (error) {
    console.error(error)
    showStatus(`图片插入失败：${error.message}`, 0)
  }
}

/* ---------------- 格式刷 ---------------- */

function currentBlockAttributes () {
  const type = editor.isActive('heading') ? 'heading' : 'paragraph'
  return editor.getAttributes(type)
}

function captureFormat () {
  const { from, to, $from } = editor.state.selection
  let marks = $from.marks()
  if (from !== to) {
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (node.isText) {
        marks = node.marks
        return false
      }
      return true
    })
  }
  const block = currentBlockAttributes()
  formatPainter = {
    marks: marks
      .filter((mark) => mark.type.name !== 'link')
      .map((mark) => ({ type: mark.type.name, attrs: { ...mark.attrs } })),
    block: {
      textAlign: block.textAlign || 'left',
      lineHeight: block.lineHeight || null,
      indent: block.indent || 0,
      spacingBefore: Number.isFinite(block.spacingBefore) ? block.spacingBefore : null,
      spacingAfter: Number.isFinite(block.spacingAfter) ? block.spacingAfter : null
    }
  }
  showStatus('已复制格式；选中目标后点“格式刷”或按 Ctrl+Shift+V 应用')
}

function applyFormatPainter () {
  if (!formatPainter) return
  const { marks, block } = formatPainter
  const chain = editor.chain().focus().unsetAllMarks()
  for (const mark of marks) chain.setMark(mark.type, mark.attrs || {})
  chain
    .setTextAlign(block.textAlign || 'left')
    .setLineHeight(block.lineHeight || null)
    .setBlockSpacing({ spacingBefore: block.spacingBefore, spacingAfter: block.spacingAfter })
    .setIndentTo(block.indent || 0)
    .run()
  formatPainter = null
  syncToolbar()
  showStatus('已应用格式')
}

/* ---------------- 图片设置 ---------------- */

const imageDialog = document.querySelector('#imageDialog')
const imageWidthInput = document.querySelector('#imageWidth')
const imageHeightInput = document.querySelector('#imageHeight')
const imageLockRatio = document.querySelector('#imageLockRatio')
let imageRatio = 1

function openImageDialog (selectedImage = null) {
  if (!editor.isActive('image')) {
    showStatus('请先在文档中单击选中图片')
    return
  }
  const attrs = editor.getAttributes('image')
  const selected = selectedImage || editor.view.dom.querySelector('img.ProseMirror-selectednode')
  const naturalWidth = selected?.naturalWidth || attrs.width || 300
  const naturalHeight = selected?.naturalHeight || attrs.height || 200
  const crop = attrs.crop || {}
  const width = Number(attrs.width) || naturalWidth
  const height = Number(attrs.height) || naturalHeight
  imageRatio = width && height ? width / height : naturalWidth / naturalHeight
  imageWidthInput.value = Math.round(width)
  imageHeightInput.value = Math.round(height)
  imageLockRatio.checked = true
  document.querySelector('#imageAlign').value = attrs.align || 'left'
  document.querySelector('#imageWrap').value = attrs.wrap || 'none'
  for (const side of ['top', 'right', 'bottom', 'left']) {
    document.querySelector(`#crop${side[0].toUpperCase()}${side.slice(1)}`).value = Number(crop[side]) || 0
  }
  if (!imageDialog.open) imageDialog.showModal()
}

imageWidthInput.addEventListener('input', () => {
  if (!imageLockRatio.checked || !imageRatio) return
  const value = Number.parseFloat(imageWidthInput.value)
  if (Number.isFinite(value) && value > 0) imageHeightInput.value = Math.round(value / imageRatio)
})

imageHeightInput.addEventListener('input', () => {
  if (!imageLockRatio.checked || !imageRatio) return
  const value = Number.parseFloat(imageHeightInput.value)
  if (Number.isFinite(value) && value > 0) imageWidthInput.value = Math.round(value * imageRatio)
})

document.querySelector('#btnApplyImage').addEventListener('click', () => {
  const width = imageWidthInput.value === '' ? null : clamp(imageWidthInput.value, 8, 5000, 300)
  const height = imageHeightInput.value === '' ? null : clamp(imageHeightInput.value, 8, 5000, 200)
  const crop = {}
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const id = `#crop${side[0].toUpperCase()}${side.slice(1)}`
    crop[side] = clamp(document.querySelector(id).value, 0, 95, 0)
  }
  if (crop.top + crop.bottom >= 100 || crop.left + crop.right >= 100) {
    showStatus('裁剪比例过大：上下或左右之和必须小于 100%', 0)
    return
  }
  editor.chain().focus().updateAttributes('image', {
    width,
    height,
    align: document.querySelector('#imageAlign').value || null,
    wrap: document.querySelector('#imageWrap').value === 'none' ? null : document.querySelector('#imageWrap').value,
    crop
  }).run()
  imageDialog.close()
})

document.querySelector('#btnReplaceImage').addEventListener('click', async () => {
  const filePath = await fileApi.showOpenDialog([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }])
  if (!filePath) return
  try {
    const data = await fileApi.readFile(filePath, true)
    const extension = filePath.split('.').pop().toLowerCase()
    const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`
    editor.chain().focus().updateAttributes('image', {
      src: `data:${mime};base64,${data}`,
      alt: fileNameFromPath(filePath),
      width: null,
      height: null,
      crop: { top: 0, right: 0, bottom: 0, left: 0 }
    }).run()
    imageDialog.close()
  } catch (error) {
    showStatus(`更换图片失败：${error.message}`, 0)
  }
})

document.querySelector('#btnDeleteImage').addEventListener('click', () => {
  editor.chain().focus().deleteSelection().run()
  imageDialog.close()
})

document.querySelector('#btnCancelImage').addEventListener('click', () => imageDialog.close())

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => document.querySelector(`#${button.dataset.closeDialog}`)?.close())
})

editor.view.dom.addEventListener('dblclick', (event) => {
  const image = event.target.closest('img')
  if (!image) return
  const pos = editor.view.posAtDOM(image, 0)
  editor.chain().focus().setNodeSelection(pos).run()
  openImageDialog(image)
})

/* ---------------- 表格属性 ---------------- */

document.querySelector('#tableBorderSize').addEventListener('change', (e) => {
  editor.chain().focus().updateAttributes('table', { borderSize: Number(e.target.value) }).run()
})

document.querySelector('#tableBorderColor').addEventListener('change', (e) => {
  editor.chain().focus().updateAttributes('table', { borderColor: e.target.value }).run()
})

document.querySelector('#cellShading').addEventListener('change', (e) => {
  editor.chain().focus().setCellAttribute('background', e.target.value).run()
})

document.querySelector('#btnClearCellShading').addEventListener('click', () => {
  editor.chain().focus().setCellAttribute('background', null).run()
})

/* ---------------- 颜色弹出层 ---------------- */

const colorPopover = document.querySelector('#colorPopover')
const highlightPopover = document.querySelector('#highlightPopover')

function buildPalette (container, colors, onPick) {
  container.innerHTML = ''
  const none = document.createElement('div')
  none.className = 'cell none'
  none.title = '无'
  none.addEventListener('click', () => onPick(null))
  container.appendChild(none)
  colors.forEach((c) => {
    const cell = document.createElement('div')
    cell.className = 'cell'
    cell.style.background = c
    cell.title = c
    cell.addEventListener('click', () => onPick(c))
    container.appendChild(cell)
  })
}

buildPalette(document.querySelector('#colorPalette'), COLORS, (c) => {
  const chain = editor.chain().focus()
  if (c) chain.setColor(c)
  else chain.unsetColor()
  chain.run()
  document.querySelector('#fontColorBar').style.borderBottomColor = c || '#c00000'
  closePopovers()
})

buildPalette(document.querySelector('#highlightPalette'), HIGHLIGHTS, (c) => {
  const chain = editor.chain().focus()
  if (c) chain.toggleHighlight({ color: c })
  else chain.unsetHighlight()
  chain.run()
  closePopovers()
})

// 弹出层贴着触发按钮左缘显示，按钮位置随布局变化也不会错位
function placePopover (popover, button) {
  const ribbon = document.querySelector('#ribbon').getBoundingClientRect()
  popover.style.left = `${Math.max(8, button.getBoundingClientRect().left - ribbon.left)}px`
}

document.querySelector('#btnFontColor').addEventListener('click', (e) => {
  e.stopPropagation()
  highlightPopover.hidden = true
  placePopover(colorPopover, e.currentTarget)
  colorPopover.hidden = !colorPopover.hidden
})

document.querySelector('#btnHighlight').addEventListener('click', (e) => {
  e.stopPropagation()
  colorPopover.hidden = true
  placePopover(highlightPopover, e.currentTarget)
  highlightPopover.hidden = !highlightPopover.hidden
})

function closePopovers () {
  colorPopover.hidden = true
  highlightPopover.hidden = true
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.popover') && !e.target.closest('.swatch')) closePopovers()
})

/* ---------------- 快捷键 ---------------- */

function isFormTarget (target) {
  return !!target?.closest?.('input, select, textarea')
}

// TipTap 自带 Mod-e（行内代码）和 Mod-Enter（换行），与 Word 的居中/分页冲突，
// 在捕获阶段先截住，避免编辑器快捷键抢先处理。
document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey || e.altKey || e.isComposing || e.defaultPrevented || isFormTarget(e.target)) return
  if (!e.shiftKey && e.key.toLowerCase() === 'e') {
    e.preventDefault()
    e.stopPropagation()
    editor.chain().focus().setTextAlign('center').run()
    return
  }
  if (e.code === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    insertPageBreak()
  }
}, true)

function changeFontSize (delta) {
  const current = Number.parseFloat(editor.getAttributes('textStyle').fontSize) || Number(settings.fontSize)
  const next = clamp(current + delta, 1, 200, current)
  editor.chain().focus().setFontSize(`${next}pt`).run()
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePopovers()
  if (e.isComposing || e.defaultPrevented) return

  if (e.key === 'F1') {
    e.preventDefault()
    openHelp()
    return
  }

  if (!e.ctrlKey || e.altKey) return
  const key = e.key.toLowerCase()
  const inForm = isFormTarget(e.target)

  if (key === 's') {
    e.preventDefault()
    saveDocument(e.shiftKey)
    return
  }
  if (inForm) return

  if (key === 'o') {
    e.preventDefault()
    openDocument()
    return
  }
  if (key === 'n') {
    e.preventDefault()
    newDocument()
    return
  }
  if (key === 'p') {
    e.preventDefault()
    openPrintPreview()
    return
  }
  if (e.code === 'Enter') {
    e.preventDefault()
    insertPageBreak()
    return
  }
  if (e.shiftKey && key === 'x') {
    e.preventDefault()
    editor.chain().focus().toggleStrike().run()
    return
  }
  if (e.shiftKey && key === 'c') {
    e.preventDefault()
    captureFormat()
    return
  }
  if (e.shiftKey && key === 'v') {
    e.preventDefault()
    applyFormatPainter()
    return
  }
  if (e.code === 'Equal') {
    e.preventDefault()
    if (e.shiftKey) editor.chain().focus().toggleSuperscript().run()
    else editor.chain().focus().toggleSubscript().run()
    return
  }
  if (e.shiftKey && e.code === 'Period') {
    e.preventDefault()
    changeFontSize(1)
    return
  }
  if (e.shiftKey && e.code === 'Comma') {
    e.preventDefault()
    changeFontSize(-1)
    return
  }
  if (e.shiftKey && e.code === 'Digit7') {
    e.preventDefault()
    editor.chain().focus().toggleOrderedList().run()
    return
  }
  if (e.shiftKey && e.code === 'Digit8') {
    e.preventDefault()
    editor.chain().focus().toggleBulletList().run()
    return
  }
  if (['l', 'e', 'r', 'j'].includes(key)) {
    e.preventDefault()
    const align = { l: 'left', e: 'center', r: 'right', j: 'justify' }[key]
    editor.chain().focus().setTextAlign(align).run()
    return
  }
  if (['1', '2', '3'].includes(key)) {
    e.preventDefault()
    editor.chain().focus().setHeading({ level: Number(key) }).run()
    return
  }
  if (key === '0') {
    e.preventDefault()
    editor.chain().focus().setParagraph().run()
    return
  }
  if (key === 'm') {
    e.preventDefault()
    if (e.shiftKey) editor.chain().focus().outdent().run()
    else editor.chain().focus().indent().run()
  }
})

/* ---------------- 工具栏状态同步 ---------------- */

function syncToolbar () {
  const setActive = (cmd, active) => {
    const el = document.querySelector(`[data-cmd="${cmd}"]`)
    if (el) {
      el.classList.toggle('active', !!active)
      el.setAttribute('aria-pressed', String(!!active))
    }
  }

  setActive('bold', editor.isActive('bold'))
  setActive('italic', editor.isActive('italic'))
  setActive('underline', editor.isActive('underline'))
  setActive('strike', editor.isActive('strike'))
  setActive('superscript', editor.isActive('superscript'))
  setActive('subscript', editor.isActive('subscript'))
  setActive('bulletList', editor.isActive('bulletList'))
  setActive('orderedList', editor.isActive('orderedList'))
  setActive('formatPainter', !!formatPainter)

  const align = ['center', 'right', 'justify'].find((a) => editor.isActive({ textAlign: a })) || 'left'
  ;['alignLeft', 'alignCenter', 'alignRight', 'alignJustify'].forEach((cmd) => setActive(cmd, false))
  setActive(`align${align[0].toUpperCase()}${align.slice(1)}`, true)

  const ts = editor.getAttributes('textStyle')
  fontFamilySel.value = ts.fontFamily || ''
  fontSizeSel.value = ts.fontSize ? ts.fontSize.replace('pt', '') : ''
  document.querySelector('#letterSpacing').value = Number.isFinite(ts.letterSpacing) ? ts.letterSpacing : ''

  if (editor.isActive('heading', { level: 1 })) document.querySelector('#blockStyle').value = 'h1'
  else if (editor.isActive('heading', { level: 2 })) document.querySelector('#blockStyle').value = 'h2'
  else if (editor.isActive('heading', { level: 3 })) document.querySelector('#blockStyle').value = 'h3'
  else document.querySelector('#blockStyle').value = 'paragraph'

  const block = currentBlockAttributes()
  document.querySelector('#lineHeight').value = block.lineHeight || ''
  document.querySelector('#spacingBefore').value = Number.isFinite(block.spacingBefore) ? block.spacingBefore : ''
  document.querySelector('#spacingAfter').value = Number.isFinite(block.spacingAfter) ? block.spacingAfter : ''

  const inTable = editor.isActive('table')
  document.querySelectorAll('[data-table-control]').forEach((control) => {
    control.disabled = !inTable
  })
  const tableAttrs = editor.getAttributes('table')
  document.querySelector('#tableBorderSize').value = String(tableAttrs.borderSize ?? 0.5)
  document.querySelector('#tableBorderColor').value = tableAttrs.borderColor || '#bfbfbf'
  const cellAttrs = editor.isActive('tableHeader') ? editor.getAttributes('tableHeader') : editor.getAttributes('tableCell')
  document.querySelector('#cellShading').value = cellAttrs.background || '#ffffff'
  document.querySelector('#tableBorderSize').disabled = !inTable
  document.querySelector('#tableBorderColor').disabled = !inTable
  document.querySelector('#cellShading').disabled = !inTable
  document.querySelector('#btnClearCellShading').disabled = !inTable

  const inImage = editor.isActive('image')
  document.querySelectorAll('[data-image-control]').forEach((control) => {
    control.disabled = !inImage
  })
}

/* ---------------- 页面设置 ---------------- */

function pageDimensions (setup = pageSetup) {
  const base = PAGE_SIZES[setup.size] || PAGE_SIZES.a4
  return setup.orientation === 'landscape'
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height }
}

function currentMargins (setup = pageSetup) {
  return setup.margins || PAGE_MARGINS[setup.margin] || PAGE_MARGINS.normal
}

function applyPageSetup () {
  const dimensions = pageDimensions()
  const margins = currentMargins()
  const paper = document.querySelector('.paper')
  paper.style.width = `${dimensions.width}cm`
  paper.style.minHeight = `${dimensions.height}cm`
  paper.style.padding = `${margins.top}cm ${margins.right}cm ${margins.bottom}cm ${margins.left}cm`
  paper.style.setProperty('--paper', pageSetup.background)
  paper.style.setProperty('--margin-top', `${margins.top}cm`)
  paper.style.setProperty('--margin-right', `${margins.right}cm`)
  paper.style.setProperty('--margin-bottom', `${margins.bottom}cm`)
  paper.style.setProperty('--margin-left', `${margins.left}cm`)
  paper.style.setProperty('--content-min-height', `${Math.max(2, dimensions.height - margins.top - margins.bottom)}cm`)
  document.querySelector('#pageSize').value = pageSetup.size
  document.querySelector('#pageOrientation').value = pageSetup.orientation
  document.querySelector('#pageMargin').value = pageSetup.margin
  document.querySelector('#pageBackground').value = pageSetup.background
  for (const side of ['top', 'right', 'bottom', 'left']) {
    const id = `#margin${side[0].toUpperCase()}${side.slice(1)}`
    document.querySelector(id).value = margins[side]
  }
  document.querySelector('#printPageStyle').textContent = `@page { size: ${dimensions.width}cm ${dimensions.height}cm; margin: ${margins.top}cm ${margins.right}cm ${margins.bottom}cm ${margins.left}cm; }`
}

function setPageSetup (patch) {
  pageSetup = normalizePageSetup({ ...pageSetup, ...patch })
  applyPageSetup()
  setDirty(true)
}

document.querySelector('#pageSize').addEventListener('change', (e) => setPageSetup({ size: e.target.value }))
document.querySelector('#pageOrientation').addEventListener('change', (e) => setPageSetup({ orientation: e.target.value }))
document.querySelector('#pageBackground').addEventListener('change', (e) => setPageSetup({ background: e.target.value }))
document.querySelector('#pageMargin').addEventListener('change', (e) => {
  if (e.target.value === 'custom') {
    setPageSetup({ margin: 'custom' })
  } else {
    setPageSetup({ margin: e.target.value, margins: { ...PAGE_MARGINS[e.target.value] } })
  }
})

document.querySelectorAll('[data-margin-side]').forEach((input) => {
  input.addEventListener('change', () => {
    const side = input.dataset.marginSide
    const margins = { ...currentMargins(), [side]: clamp(input.value, 0, 10, 2.54) }
    setPageSetup({ margin: 'custom', margins })
  })
})

/* ---------------- 文件与自动保存 ---------------- */

const FILE_FILTERS = [
  { name: 'Word 文档', extensions: ['docx'] },
  { name: '纯文本', extensions: ['txt'] }
]

function showStatus (message, duration = 5000) {
  clearTimeout(statusTimer)
  document.querySelector('#fileStatus').textContent = message
  if (duration) {
    statusTimer = setTimeout(() => { document.querySelector('#fileStatus').textContent = '' }, duration)
  }
}

function updateDocumentState () {
  fileApi.setDocumentState(dirty, currentFileName)
}

function setDirty (value) {
  if (dirty === value) return
  dirty = value
  updateDocumentState()
}

function handleEditorUpdate () {
  updateStatusBar()
  syncToolbar()
  if (!loadingDocument) setDirty(true)
}

function setEditorJSON (json) {
  loadingDocument = true
  editor.commands.setContent(json)
  // setContent 不会清空撤销栈，跨文档撤销可能把上一份文档的内容带回/清空当前文档。
  // 用同一份 doc 和插件重建 EditorState，让 history 插件重新初始化。
  const state = editor.state
  editor.view.updateState(EditorState.create({
    doc: state.doc,
    plugins: state.plugins,
    selection: state.selection
  }))
  loadingDocument = false
  updateStatusBar()
  syncToolbar()
}

function fileNameFromPath (filePath) {
  return filePath.split(/[\\/]/).pop()
}

function formatFromPath (filePath) {
  const extension = filePath.split('.').pop().toLowerCase()
  if (extension === 'docx') return 'docx'
  if (extension === 'txt') return 'txt'
  return null
}

function currentJSON () {
  return editor.getJSON()
}

function nodeText (node) {
  if (node.type === 'text') return node.text || ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'image') return node.attrs?.alt || ''
  return (node.content || []).map(nodeText).join('')
}

function plainBlock (node) {
  if (node.type === 'table') {
    return (node.content || []).map((row) => (row.content || []).map(nodeText).join('\t')).join('\n')
  }
  if (node.type === 'bulletList' || node.type === 'orderedList') {
    return (node.content || []).map(nodeText).join('\n')
  }
  return nodeText(node)
}

function textToJSON (text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  }
}

function resetDocumentPosition () {
  editor.chain().focus().setTextSelection(1).run()
  const workspace = document.querySelector('#workspace')
  workspace.scrollTop = 0
  requestAnimationFrame(() => { workspace.scrollTop = 0 })
}

async function canDiscardChanges () {
  if (!dirty) return true
  return fileApi.confirmAction('当前文档有未保存的更改，继续将丢失这些更改。是否继续？')
}

function applyDefaultStyles () {
  const root = document.documentElement
  root.style.setProperty('--doc-font-family', settings.fontFamily)
  root.style.setProperty('--doc-font-size', `${settings.fontSize}pt`)
  root.style.setProperty('--doc-line-height', settings.lineHeight)
}

function scheduleAutoSave () {
  clearTimeout(autosaveTimer)
  const minutes = Number(settings.autosaveMinutes)
  if (!(minutes > 0)) return
  autosaveTimer = setTimeout(async () => {
    await autoSave()
    scheduleAutoSave()
  }, minutes * 60000)
}

async function newDocument () {
  if (!await canDiscardChanges()) return
  currentPath = null
  currentFileName = '未命名文档'
  currentFormat = 'docx'
  pageSetup = pageSetupFromSettings()
  setEditorJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  applyPageSetup()
  dirty = false
  updateDocumentState()
  await fileApi.clearAutosave()
  showStatus('已新建文档')
  resetDocumentPosition()
}

async function loadFile (filePath) {
  try {
    const format = formatFromPath(filePath)
    if (!format) throw new Error('仅支持 .docx 和 .txt 文件')
    const data = await fileApi.readFile(filePath, format === 'docx')
    let json
    let importedPageSetup = null
    if (format === 'docx') {
      const result = await docxBase64ToJSON(data, editorExtensions)
      json = result.json
      importedPageSetup = result.pageSetup
      if (result.warnings.length) console.warn('[docx]', result.warnings)
    } else {
      json = textToJSON(data)
    }
    setEditorJSON(json)
    pageSetup = normalizePageSetup(importedPageSetup || pageSetupFromSettings())
    applyPageSetup()
    currentPath = filePath
    currentFileName = fileNameFromPath(filePath)
    currentFormat = format
    dirty = false
    updateDocumentState()
    await fileApi.clearAutosave()
    addRecentFile(filePath)
    showStatus(format === 'docx' ? 'DOCX 已导入；部分复杂对象可能已简化或忽略' : `已打开 ${currentFileName}`, format === 'docx' ? 8000 : 5000)
    resetDocumentPosition()
    return true
  } catch (error) {
    console.error(error)
    showStatus(`打开失败：${error.message}`, 0)
    removeRecentFile(filePath)
    return false
  }
}

async function openDocument () {
  if (!await canDiscardChanges()) return
  const filePath = await fileApi.showOpenDialog(FILE_FILTERS)
  if (!filePath) return
  await loadFile(filePath)
}

async function openRecentFile (filePath) {
  if (!await canDiscardChanges()) return
  await loadFile(filePath)
}

async function saveDocument (saveAs = false) {
  if (saveInProgress) return false
  saveInProgress = true
  try {
    let filePath = currentPath
    if (saveAs || !filePath) {
      const defaultPath = currentPath || (currentFileName === '未命名文档' ? '未命名文档.docx' : currentFileName)
      filePath = await fileApi.showSaveDialog(defaultPath, FILE_FILTERS)
      if (!filePath) {
        showStatus('已取消保存')
        return false
      }
    }
    let format = formatFromPath(filePath)
    if (!format) {
      filePath += '.docx'
      format = 'docx'
    }
    const json = currentJSON()
    const data = format === 'txt'
      ? (json.content || []).map(plainBlock).join('\n')
      : await jsonToDocxBase64(json, pageSetup, settings)
    await fileApi.writeFile(filePath, data, format === 'docx')
    currentPath = filePath
    currentFileName = fileNameFromPath(filePath)
    currentFormat = format
    dirty = false
    updateDocumentState()
    await fileApi.clearAutosave().catch(() => {})
    addRecentFile(filePath)
    showStatus(`已保存 ${currentFileName}`)
    return true
  } catch (error) {
    console.error(error)
    showStatus(`保存失败：${error.message}`, 0)
    return false
  } finally {
    saveInProgress = false
  }
}

async function autoSave () {
  if (!dirty || saveInProgress) return
  const payload = {
    version: 1,
    content: currentJSON(),
    timestamp: Date.now(),
    fileName: currentFileName,
    filePath: currentPath,
    format: currentFormat,
    pageSetup: { ...pageSetup }
  }
  try {
    await fileApi.writeAutosave(payload)
  } catch (error) {
    console.error(error)
    showStatus('自动保存失败', 8000)
  }
}

async function restoreAutosave () {
  if (isSmoke) return
  try {
    const payload = await fileApi.readAutosave()
    if (!payload?.content) return
    const restore = await fileApi.confirmAction('是否恢复上次未保存的内容？')
    if (!restore) {
      await fileApi.clearAutosave()
      return
    }
    setEditorJSON(payload.content)
    const savedFormat = payload.format || (payload.filePath ? formatFromPath(payload.filePath) : 'docx')
    currentFormat = ['docx', 'txt'].includes(savedFormat) ? savedFormat : 'docx'
    currentPath = currentFormat === savedFormat ? payload.filePath || null : null
    currentFileName = payload.fileName || (currentPath ? fileNameFromPath(currentPath) : '未命名文档')
    if (currentFormat !== savedFormat) currentFileName = currentFileName.replace(/\.[^.]+$/, '.docx')
    pageSetup = normalizePageSetup({ ...pageSetupFromSettings(), ...(payload.pageSetup || {}) })
    applyPageSetup()
    dirty = true
    updateDocumentState()
    showStatus('已恢复上次未保存的内容', 8000)
  } catch (error) {
    console.error(error)
    showStatus('自动备份无法读取，未恢复', 8000)
  }
}

/* ---------------- 最近文件 ---------------- */

function saveRecentFiles () {
  storageWrite(RECENT_KEY, recentFiles)
}

function addRecentFile (filePath) {
  const item = { path: filePath, name: fileNameFromPath(filePath), time: Date.now() }
  recentFiles = [item, ...recentFiles.filter((entry) => entry.path !== filePath)].slice(0, MAX_RECENT)
  saveRecentFiles()
  renderRecentFiles()
}

function removeRecentFile (filePath) {
  recentFiles = recentFiles.filter((entry) => entry.path !== filePath)
  saveRecentFiles()
  renderRecentFiles()
}

function renderRecentFiles () {
  const list = document.querySelector('#recentList')
  if (!list) return
  list.innerHTML = ''
  if (!recentFiles.length) {
    const empty = document.createElement('div')
    empty.className = 'recent-empty'
    empty.textContent = '还没有最近打开的文件'
    list.appendChild(empty)
    return
  }
  for (const entry of recentFiles) {
    const button = document.createElement('button')
    button.className = 'recent-item'
    button.type = 'button'
    button.title = entry.path
    const name = document.createElement('span')
    name.className = 'recent-name'
    name.textContent = entry.name || fileNameFromPath(entry.path)
    const path = document.createElement('span')
    path.className = 'recent-path'
    path.textContent = entry.path
    button.append(name, path)
    button.addEventListener('click', () => openRecentFile(entry.path))
    list.appendChild(button)
  }
}

document.querySelector('#btnClearRecent').addEventListener('click', () => {
  recentFiles = []
  saveRecentFiles()
  renderRecentFiles()
})

/* ---------------- 设置与帮助 ---------------- */

const settingsDialog = document.querySelector('#settingsDialog')
const helpDialog = document.querySelector('#helpDialog')

function populateSettingsForm (source = settings) {
  document.querySelector('#settingsFont').value = source.fontFamily
  document.querySelector('#settingsFontSize').value = source.fontSize
  document.querySelector('#settingsLineHeight').value = source.lineHeight
  document.querySelector('#settingsPageSize').value = source.pageSize
  document.querySelector('#settingsPageOrientation').value = source.pageOrientation
  document.querySelector('#settingsPageMargin').value = source.pageMargin
  document.querySelector('#settingsAutosave').value = source.autosaveMinutes
}

function openSettings () {
  populateSettingsForm()
  if (!settingsDialog.open) settingsDialog.showModal()
}

document.querySelector('#btnOpenSettings').addEventListener('click', openSettings)
document.querySelector('#btnCancelSettings').addEventListener('click', () => settingsDialog.close())

document.querySelector('#settingsForm').addEventListener('submit', (event) => {
  event.preventDefault()
  settings = normalizeSettings({
    fontFamily: document.querySelector('#settingsFont').value,
    fontSize: document.querySelector('#settingsFontSize').value,
    lineHeight: document.querySelector('#settingsLineHeight').value,
    pageSize: document.querySelector('#settingsPageSize').value,
    pageOrientation: document.querySelector('#settingsPageOrientation').value,
    pageMargin: document.querySelector('#settingsPageMargin').value,
    autosaveMinutes: document.querySelector('#settingsAutosave').value
  })
  storageWrite(SETTINGS_KEY, settings)
  applyDefaultStyles()
  scheduleAutoSave()
  settingsDialog.close()
  showStatus('设置已保存；默认字体/页面对新文档生效')
})

document.querySelector('#btnResetSettings').addEventListener('click', () => {
  populateSettingsForm(DEFAULT_SETTINGS)
})

function openHelp () {
  if (!helpDialog.open) helpDialog.showModal()
}

document.querySelector('#btnOpenHelp').addEventListener('click', openHelp)
document.querySelector('#btnCloseHelp').addEventListener('click', () => helpDialog.close())
document.querySelector('#helpVersion').textContent = `版本 ${window.wordlite.appInfo?.version || '0.1.0'}`

/* ---------------- 打印预览与 PDF ---------------- */

const printPreviewDialog = document.querySelector('#printPreviewDialog')
let previewPages = 0

function createPreviewPage () {
  const dims = pageDimensions()
  const margins = currentMargins()
  const page = document.createElement('div')
  page.className = 'preview-page'
  page.style.width = `${dims.width}cm`
  page.style.minHeight = `${dims.height}cm`
  page.style.padding = `${margins.top}cm ${margins.right}cm ${margins.bottom}cm ${margins.left}cm`
  page.style.background = pageSetup.background
  const body = document.createElement('div')
  body.className = 'ProseMirror preview-content'
  body.contentEditable = 'false'
  page.appendChild(body)
  return { page, body }
}

function renderPrintPreview () {
  const container = document.querySelector('#previewPages')
  container.innerHTML = ''
  const clone = editor.view.dom.cloneNode(true)
  clone.removeAttribute('contenteditable')
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
  clone.querySelectorAll('.ProseMirror-selectednode').forEach((el) => el.classList.remove('ProseMirror-selectednode'))
  clone.querySelectorAll('.ProseMirror-gapcursor').forEach((el) => el.remove())
  clone.querySelectorAll('.column-resize-handle').forEach((el) => el.remove())

  let { page, body } = createPreviewPage()
  const pages = [page]
  for (const node of Array.from(clone.childNodes)) {
    if (node.nodeType === 1 && node.matches('.page-break')) {
      const next = createPreviewPage()
      pages.push(next.page)
      page = next.page
      body = next.body
      page.appendChild(body)
      continue
    }
    body.appendChild(node.cloneNode(true))
  }
  for (const [index, item] of pages.entries()) {
    const label = document.createElement('div')
    label.className = 'preview-label'
    label.textContent = `第 ${index + 1} 页`
    container.append(label, item)
  }
  previewPages = pages.length

  const dims = pageDimensions()
  const scroll = document.querySelector('#previewScroll')
  const available = Math.max(260, scroll.clientWidth - 36)
  const zoom = Math.min(1, available / (dims.width * 37.7952756))
  for (const item of pages) item.style.zoom = String(zoom)
  const margin = currentMargins()
  document.querySelector('#previewMeta').textContent =
    `${pageSetup.size.toUpperCase()} · ${pageSetup.orientation === 'portrait' ? '纵向' : '横向'} · 页边距 ${margin.top}/${margin.right}/${margin.bottom}/${margin.left} cm · ${previewPages} 页（按分页符）`
}

function openPrintPreview () {
  renderPrintPreview()
  document.querySelector('#printPageRanges').value = ''
  document.querySelector('#printPageRanges').classList.remove('invalid')
  document.querySelector('#printCopies').value = '1'
  document.querySelector('#printRangeError').textContent = ''
  if (!printPreviewDialog.open) printPreviewDialog.showModal()
}

document.querySelector('#btnPrint').addEventListener('click', openPrintPreview)
document.querySelector('#btnPrintPreview').addEventListener('click', openPrintPreview)
document.querySelector('#btnCancelPrint').addEventListener('click', () => printPreviewDialog.close())

document.querySelector('#printPageRanges').addEventListener('input', (e) => {
  document.querySelector('#printRangeError').textContent = ''
  e.target.classList.remove('invalid')
})

document.querySelector('#btnDoPrint').addEventListener('click', () => {
  const rangeText = document.querySelector('#printPageRanges').value.trim()
  const rangeError = document.querySelector('#printRangeError')
  if (rangeText && !/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(rangeText)) {
    rangeError.textContent = '页码格式示例：1-3,5'
    document.querySelector('#printPageRanges').classList.add('invalid')
    return
  }
  if (rangeText) {
    const invalidBounds = rangeText.split(',').some((part) => {
      const [fromText, toText] = part.trim().split(/\s*-\s*/)
      const from = Number(fromText)
      const to = toText === undefined ? from : Number(toText)
      return from < 1 || to < from
    })
    if (invalidBounds) {
      rangeError.textContent = '页码需从 1 开始，且起始页不能大于结束页'
      document.querySelector('#printPageRanges').classList.add('invalid')
      return
    }
  }
  const copies = Math.round(clamp(document.querySelector('#printCopies').value, 1, 99, 1))
  fileApi.print({ pageRanges: rangeText, copies })
  printPreviewDialog.close()
})

document.querySelector('#btnExportPdf').addEventListener('click', async () => {
  const defaultPath = `${currentFileName.replace(/\.[^.]+$/, '')}.pdf`
  try {
    const result = await fileApi.exportPdf(defaultPath)
    if (result?.saved) showStatus(`PDF 已导出：${result.path}`)
  } catch (error) {
    showStatus(`PDF 导出失败：${error.message}`, 0)
  }
})

/* ---------------- 启动 ---------------- */

document.querySelector('#btnNew').addEventListener('click', newDocument)
document.querySelector('#btnOpen').addEventListener('click', openDocument)
document.querySelector('#btnSave').addEventListener('click', () => saveDocument())
document.querySelector('#btnSaveAs').addEventListener('click', () => saveDocument(true))

fileApi.onSaveBeforeClose(async () => {
  if (await saveDocument()) fileApi.closeAfterSave()
})

/* ---------------- 状态栏 ---------------- */

function updateStatusBar () {
  const n = editor.storage.characterCount.characters()
  document.querySelector('#wordCount').textContent = `字数 ${n}`
}

// 设置里的默认字体/字号/行距只作用于未单独设格式的文字；新文档优先采用这些默认值
applyDefaultStyles()
populateSettingsForm()
renderRecentFiles()
updateStatusBar()
syncToolbar()
updateDocumentState()
applyPageSetup()
scheduleAutoSave()
restoreAutosave()
