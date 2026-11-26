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
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { redoDepth, undoDepth } from '@tiptap/pm/history'
import {
  FindHighlight,
  findHighlightKey,
  SelectionImageHighlight,
  imageCropFrame,
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
  StrikeWithShortcut,
  normalizeHexColor
} from './extensions.js'
import { docxBase64ToJSON, jsonToDocxBase64 } from './docx.js'
import { Pagination, createPaginator, PAGE_GAP_DEFAULT } from './pagination.js'

/* ---------------- 常量 ---------------- */

// 第一项必须是 Windows 字体名：docx.js 导出时只取逗号前的第一个名字写进 DOCX，
// 后面补的是 Mac 上的同族字体，只影响屏幕显示。
const FONTS = [
  { label: '等线', value: 'DengXian, 等线, "Microsoft YaHei", 微软雅黑, "PingFang SC", sans-serif' },
  { label: '宋体', value: 'SimSun, 宋体, "Songti SC", STSong, serif' },
  { label: '黑体', value: 'SimHei, 黑体, "Heiti SC", STHeiti, sans-serif' },
  { label: '仿宋', value: 'FangSong, 仿宋, STFangsong, SimSun, serif' },
  { label: '楷体', value: 'KaiTi, 楷体, "Kaiti SC", STKaiti, serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", 微软雅黑, "PingFang SC", sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Times New Roman', value: '"Times New Roman", serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Consolas', value: 'Consolas, Menlo, "SF Mono", monospace' },
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
// 平台判断由 tauri-bridge.js 写入；Electron 里没有这个字段，按 Windows 处理
const isMac = window.wordlite.platform === 'mac'
document.documentElement.classList.toggle('is-mac', isMac)
// Mac 上所有快捷键用 ⌘；Ctrl 组合键一律不拦截（Ctrl+A/E/K/H 是系统的文本编辑键位）
const isMod = (e) => isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey
const isSmoke = new URLSearchParams(location.search).has('smoke')
let currentPath = null
let currentFileName = '未命名文档'
let currentFormat = 'docx'
let dirty = false
let loadingDocument = false
let saveInProgress = false
let txtWarningAccepted = false
let statusTimer = null
let autosaveTimer = null
let formatPainter = null
let recentFiles = []
let paginator = null

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

// 字体值是整串 CSS 字体栈，版本升级后可能对不上：按第一个字体名找回当前的值，
// 避免老用户存在本地的默认字体被重置
function normalizeFontFamily (value) {
  if (FONTS.some((font) => font.value === value)) return value
  const first = String(value || '').split(',')[0].replace(/["']/g, '').trim().toLowerCase()
  if (!first) return DEFAULT_SETTINGS.fontFamily
  const match = FONTS.find((font) => font.value.split(',')[0].replace(/["']/g, '').trim().toLowerCase() === first)
  return match ? match.value : DEFAULT_SETTINGS.fontFamily
}

// DOCX 里只存一个字体名（并写全 ascii/hAnsi/eastAsia/cs 四个属性），导入时按名字映射回上面的
// 字体栈：下拉框按整串取值显示「仿宋」，导出仍只取第一个名字，映射不改变写回 DOCX 的字体名。
// 不在列表里的字体名返回 null，导入侧原样保留。
const GENERIC_FONTS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'])
const FONT_TOKENS = new Map(FONTS.map((font) => [font, font.value.split(',')
  .map((item) => item.replace(/["']/g, '').trim().toLowerCase())
  .filter((item) => item && !GENERIC_FONTS.has(item))]))
function fontFamilyFromName (name) {
  const value = String(name || '').replace(/["']/g, '').trim().toLowerCase()
  if (!value || GENERIC_FONTS.has(value)) return null
  // 先按字体栈的第一个名字（写回 DOCX 的就是它），再按下拉框的标签（「微软雅黑」「等线」这类中文名）
  const exact = FONTS.find((font) => FONT_TOKENS.get(font)[0] === value)
  if (exact) return exact.value
  const label = FONTS.find((font) => font.label.toLowerCase() === value)
  if (label) return label.value
  // 最后按回退名字匹配，取在字体栈里位置最靠前的那个：
  // 微软雅黑同时出现在等线的回退里，按名字扫会先撞上等线，所以用位置排序而不是第一命中
  let best = null
  let bestIndex = Infinity
  for (const font of FONTS) {
    const index = FONT_TOKENS.get(font).indexOf(value)
    if (index > 0 && index < bestIndex) {
      best = font
      bestIndex = index
    }
  }
  return best ? best.value : null
}

function normalizeSettings (input = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) }
  settings.fontFamily = normalizeFontFamily(settings.fontFamily)
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
  const pageNumber = ['none', 'screen', 'print'].includes(setup.pageNumber) ? setup.pageNumber : 'none'
  const headerText = typeof setup.headerText === 'string' ? setup.headerText.slice(0, 120) : ''
  const footerText = typeof setup.footerText === 'string' ? setup.footerText.slice(0, 120) : ''
  const headerFooterAlign = ['left', 'center', 'right'].includes(setup.headerFooterAlign) ? setup.headerFooterAlign : 'center'
  const headerFooterFontSize = Math.round(clamp(setup.headerFooterFontSize, 6, 24, 9) * 2) / 2
  const lineBreaking = setup.lineBreaking === 'blocks' ? 'blocks' : 'lines'
  return {
    size, orientation, margin: preset, margins, background,
    pageNumber, headerText, footerText, headerFooterAlign, headerFooterFontSize, lineBreaking
  }
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
  PlainTextInput,
  FindHighlight,
  SelectionImageHighlight,
  Pagination
]

const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: editorExtensions,
  content: '<p></p>',
  onSelectionUpdate: syncToolbar,
  onUpdate: handleEditorUpdate
})

/* ---------------- 空白处拖选 ---------------- */

// 按在页边距或纸外灰底上时 ProseMirror 收不到事件，光标会停在原处。
// 这里把按点换算成最近的正文位置：左右边距落到该行的行首/行尾，上下越界落到文首/文末。

const workspaceEl = document.querySelector('#workspace')
let blankDrag = null
let blankDragFrame = 0

function blankPos (clientX, clientY) {
  const doc = editor.state.doc
  const view = editor.view
  const box = view.dom.getBoundingClientRect()
  if (clientY < box.top) return 0
  if (clientY > box.bottom) return doc.content.size
  // 夹到正文左右边界内，posAtCoords 才会按这一行算出最近的位置
  const left = Math.min(box.right - 1, Math.max(box.left + 1, clientX))
  const hit = view.posAtCoords({ left, top: clientY })
  return hit ? hit.pos : (clientY < (box.top + box.bottom) / 2 ? 0 : doc.content.size)
}

function blankDragApply () {
  if (!blankDrag) return
  const doc = editor.state.doc
  const selection = TextSelection.between(
    doc.resolve(blankDrag.anchor),
    doc.resolve(blankPos(blankDrag.x, blankDrag.y))
  )
  if (selection.eq(editor.state.selection)) return
  editor.view.dispatch(editor.state.tr.setSelection(selection))
}

function blankDragMove (event) {
  if (!blankDrag) return
  blankDrag.x = event.clientX
  blankDrag.y = event.clientY
  blankDragApply()
  blankDragAutoScroll()
}

function blankDragEnd () {
  if (!blankDrag) return
  const pointerId = blankDrag.pointerId
  blankDrag = null
  cancelAnimationFrame(blankDragFrame)
  blankDragFrame = 0
  window.removeEventListener('pointermove', blankDragMove)
  window.removeEventListener('pointerup', blankDragEnd)
  window.removeEventListener('pointercancel', blankDragEnd)
  window.removeEventListener('blur', blankDragEnd)
  if (workspaceEl.hasPointerCapture?.(pointerId)) workspaceEl.releasePointerCapture(pointerId)
}

// 鼠标停在可视区上下边缘附近时持续滚动，滚完按新版面重算选区
function blankDragAutoScroll () {
  const rect = workspaceEl.getBoundingClientRect()
  const edge = 48
  let step = 0
  if (blankDrag.y < rect.top + edge) step = -Math.ceil((rect.top + edge - blankDrag.y) / 6)
  else if (blankDrag.y > rect.bottom - edge) step = Math.ceil((blankDrag.y - rect.bottom + edge) / 6)
  if (!step) {
    cancelAnimationFrame(blankDragFrame)
    blankDragFrame = 0
    return
  }
  step = Math.max(-30, Math.min(30, step))
  const before = workspaceEl.scrollTop
  workspaceEl.scrollTop = before + step
  if (workspaceEl.scrollTop !== before) blankDragApply()
  if (!blankDragFrame) blankDragFrame = requestAnimationFrame(blankDragScroll)
}

function blankDragScroll () {
  blankDragFrame = 0
  if (!blankDrag) return
  blankDragAutoScroll()
}

// 点在滚动条上时不算空白处，避免拖动滑块时改选区
function onScrollbar (event) {
  const rect = workspaceEl.getBoundingClientRect()
  return event.clientX >= rect.left + workspaceEl.clientWidth ||
    event.clientY >= rect.top + workspaceEl.clientHeight
}

workspaceEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.defaultPrevented || onScrollbar(event)) return
  if (event.target.closest?.('.ProseMirror')) return
  event.preventDefault()
  blankDrag = {
    // Shift+单击空白处沿用现有选区的起点，继续扩展
    anchor: event.shiftKey ? editor.state.selection.anchor : blankPos(event.clientX, event.clientY),
    x: event.clientX,
    y: event.clientY,
    pointerId: event.pointerId
  }
  blankDragApply()
  editor.view.focus()
  // 捕获指针，拖出窗口也还能继续收到移动事件
  try {
    workspaceEl.setPointerCapture(event.pointerId)
  } catch {
    // 个别环境不支持指针捕获，退回只有在窗口内有效的拖动
  }
  window.addEventListener('pointermove', blankDragMove)
  window.addEventListener('pointerup', blankDragEnd)
  window.addEventListener('pointercancel', blankDragEnd)
  window.addEventListener('blur', blankDragEnd)
})

/* ---------------- 拖动到边缘自动滚动 ---------------- */

// 正文滚动容器是 #workspace；浏览器原生拖放只管它自己的视口，
// 这里在拖动过程中按住边缘 40px 以内时自己滚，并在滚动后重算落点竖线
const DRAG_SCROLL_EDGE = 40
let dragScrollTimer = 0
let dragScrollPoint = null

function dragAutoScrollStep () {
  if (!dragScrollPoint) return 0
  const rect = workspaceEl.getBoundingClientRect()
  const { x, y } = dragScrollPoint
  if (y < rect.top + DRAG_SCROLL_EDGE) {
    return -Math.min(24, Math.max(6, Math.ceil((rect.top + DRAG_SCROLL_EDGE - y) / 3)))
  }
  if (y > rect.bottom - DRAG_SCROLL_EDGE) {
    return Math.min(24, Math.max(6, Math.ceil((y - rect.bottom + DRAG_SCROLL_EDGE) / 3)))
  }
  return 0
}

function dragAutoScrollTick () {
  const step = dragAutoScrollStep()
  if (!step) { dragScrollTimer = 0; return }
  const before = workspaceEl.scrollTop
  workspaceEl.scrollTop = before + step
  // 滚动后光标下的文档位置变了：补一次 dragover，让 Dropcursor 竖线跟到新位置
  if (workspaceEl.scrollTop !== before && dragScrollPoint) {
    const { x, y } = dragScrollPoint
    editor.view.dom.dispatchEvent(new DragEvent('dragover', { clientX: x, clientY: y, bubbles: true, cancelable: true }))
  }
  dragScrollTimer = requestAnimationFrame(dragAutoScrollTick)
}

function dragScrollMove (event) {
  dragScrollPoint = { x: event.clientX, y: event.clientY }
  if (!dragScrollTimer && dragAutoScrollStep()) {
    dragScrollTimer = requestAnimationFrame(dragAutoScrollTick)
  }
}

function dragScrollEnd () {
  dragScrollPoint = null
  dragScrollTimer = 0
  editor.view.dom.removeEventListener('dragover', dragScrollMove)
  document.removeEventListener('dragend', dragScrollEnd)
  document.removeEventListener('drop', dragScrollEnd)
}

// 组合状态要报给原生层（Mac）：WKWebView 收到右键时会在原生层就把没上屏的拼音
// 摊成字母，渲染层拦不住。原生监听只认这一个标志，所以它必须跟真组合同生共死
if (isMac && fileApi.setImeComposing) {
  let reportingCompose = false
  const reportCompose = (composing) => {
    if (reportingCompose === composing) return
    reportingCompose = composing
    fileApi.setImeComposing(composing)
  }
  for (const type of ['compositionstart', 'compositionend']) {
    document.addEventListener(type, () => reportCompose(type === 'compositionstart'), true)
  }
  // 失焦 / 切窗口时组合已经没了，别把标志留在 true 上（否则下一次右键会被莫名吞掉）
  window.addEventListener('blur', () => reportCompose(false), true)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reportCompose(false)
  }, true)
}

// ProseMirror 的 mousedown 第一件事就是 endComposition，等 dragstart 再查
// view.composing 永远是 false。所以在捕获阶段先记下「按下那一刻」是否在组合中。
let composingAtPress = false
// 双击的第一次按下会顺手结束组合，第二次按下时 view.composing 已经是 false，
// 所以再记一个时间戳，让整组双击都算「组合中按下的」
let composingPressAt = 0
editor.view.dom.addEventListener('mousedown', (event) => {
  composingAtPress = editor.view.composing || event.isComposing === true
  if (composingAtPress) composingPressAt = Date.now()
}, true)

// 右键也是同一个问题：PM 的 mousedown 里 endComposition 会把还没上屏的拼音就地提交，
// 等 contextmenu 事件到了再查 composing 已经晚了。所以在 document 捕获阶段（早于
// view.dom 上的任何监听）就把这次按下截住，PM 根本收不到，组合原样留着。
// Mac 的 Control+点 是同一种「右键」，但按下事件的 button 是 0、只是 ctrlKey 为 true，
// 只认 button === 2 的话这道拦截在 Mac 上等于不存在
function isRightButtonPress (event) {
  if (event.button === 2) return true
  return isMac && event.button === 0 && event.ctrlKey
}
let composingRightPressAt = 0
document.addEventListener('mousedown', (event) => {
  if (!isRightButtonPress(event)) return
  composingRightPressAt = 0
  if (!(editor.view.composing || event.isComposing === true)) return
  composingRightPressAt = Date.now()
  event.stopPropagation()
}, true)

// 只在正文开始拖动后接管（拖文件进来时不滚，交给系统默认）
editor.view.dom.addEventListener('dragstart', (event) => {
  // 输入法组合中按下去拖，会把还没上屏的拼音一起搬走；preventDefault 直接废掉这次拖拽
  if (printing || composingAtPress || editor.view.composing || event.isComposing === true) {
    event.preventDefault()
    return
  }
  editor.view.dom.addEventListener('dragover', dragScrollMove)
  document.addEventListener('dragend', dragScrollEnd)
  document.addEventListener('drop', dragScrollEnd)
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

const detailFontSel = document.querySelector('#detailFont')
const detailFontSizeSel = document.querySelector('#detailFontSize')
FONTS.forEach((f) => detailFontSel.add(new Option(f.label, f.value)))
detailFontSel.add(new Option('默认', ''), 0)
detailFontSel.value = ''
SIZES.forEach((s) => detailFontSizeSel.add(new Option(s, s)))
detailFontSizeSel.add(new Option('默认', ''), 0)
detailFontSizeSel.value = ''

// 中文字号名只在常用磅值上标；没有对应名称就直接写磅
const SIZE_NAMES = {
  9: '小五', 10.5: '五号', 12: '小四', 14: '四号', 16: '三号',
  18: '小二', 22: '二号', 24: '小一', 26: '一号', 36: '小初'
}

function updateDefaultFormatLabels () {
  const font = FONTS.find((item) => item.value === settings.fontFamily) || FONTS[0]
  const sizeName = SIZE_NAMES[Number(settings.fontSize)]
  const sizeLabel = sizeName ? sizeName : `${settings.fontSize} 磅`
  fontFamilySel.options[0].textContent = `字体：${font.label}（默认）`
  fontSizeSel.options[0].textContent = `字号：${sizeLabel}（默认）`
  if (detailFontSel.options[0]) detailFontSel.options[0].textContent = `默认（${font.label}）`
  if (detailFontSizeSel.options[0]) detailFontSizeSel.options[0].textContent = `默认（${sizeLabel}）`
}

updateDefaultFormatLabels()

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

// 行距下拉里临时插入的“固定值 / 非标准倍数”选项：只保留当前值一个，换段落就清掉
function syncDynamicOption (select, value, label) {
  select.querySelectorAll('option[data-dynamic]').forEach((option) => {
    if (option.value !== value) option.remove()
  })
  if (!value) {
    select.value = ''
    return
  }
  let option = Array.from(select.options).find((item) => item.value === value)
  if (!option) {
    option = document.createElement('option')
    option.value = value
    option.dataset.dynamic = '1'
    select.appendChild(option)
  }
  if (option.dataset.dynamic) option.textContent = label
  select.value = value
}

document.querySelector('#lineHeight').addEventListener('change', (e) => {
  if (e.target.value === '__paragraph__') {
    openParagraphDialog()
    syncToolbar()
    return
  }
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

/* ---------------- 段落设置（行距 / 段前 / 段后） ---------------- */

const paragraphDialog = document.querySelector('#paragraphDialog')
const paragraphPreview = document.querySelector('#paragraphPreview')
const paraLineMode = document.querySelector('#paraLineMode')
const paraLinePt = document.querySelector('#paraLinePt')
const paraBefore = document.querySelector('#paraBefore')
const paraAfter = document.querySelector('#paraAfter')

function updateParagraphPreview () {
  const mode = paraLineMode.value
  if (mode === 'exact') {
    paragraphPreview.style.lineHeight = `${clamp(paraLinePt.value, 1, 500, 20)}pt`
  } else {
    paragraphPreview.style.lineHeight = mode || ''
  }
  const before = paraBefore.value === '' ? 0 : clamp(paraBefore.value, 0, 200, 0)
  const after = paraAfter.value === '' ? 0 : clamp(paraAfter.value, 0, 200, 0)
  for (const p of paragraphPreview.querySelectorAll('p')) {
    p.style.marginTop = `${before}pt`
    p.style.marginBottom = `${after}pt`
  }
}

function openParagraphDialog () {
  const block = currentBlockAttributes()
  const raw = block.lineHeight == null ? '' : String(block.lineHeight)
  const exact = /^([\d.]+)pt$/i.exec(raw)
  // 清掉上一次为“非标准倍数”临时加的选项
  paraLineMode.querySelectorAll('option[data-dynamic]').forEach((option) => option.remove())
  paraLinePt.disabled = !exact
  if (exact) {
    paraLineMode.value = 'exact'
    paraLinePt.value = String(Number(exact[1]))
  } else if (raw && !Array.from(paraLineMode.options).some((option) => option.value === raw)) {
    const option = document.createElement('option')
    option.value = raw
    option.textContent = `${raw} 倍行距`
    option.dataset.dynamic = '1'
    paraLineMode.appendChild(option)
    paraLineMode.value = raw
  } else {
    paraLineMode.value = raw
  }
  paraBefore.value = Number.isFinite(block.spacingBefore) ? block.spacingBefore : ''
  paraAfter.value = Number.isFinite(block.spacingAfter) ? block.spacingAfter : ''
  updateParagraphPreview()
  if (!paragraphDialog.open) paragraphDialog.showModal()
}

document.querySelector('#btnOpenParagraph').addEventListener('click', openParagraphDialog)
document.querySelector('#btnCancelParagraph').addEventListener('click', () => paragraphDialog.close())
paraLineMode.addEventListener('change', () => {
  paraLinePt.disabled = paraLineMode.value !== 'exact'
  updateParagraphPreview()
})
for (const input of [paraLinePt, paraBefore, paraAfter]) {
  input.addEventListener('input', updateParagraphPreview)
}

document.querySelector('#paragraphForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const mode = paraLineMode.value
  const chain = editor.chain().focus()
  if (!mode) chain.setLineHeight(null)
  else if (mode === 'exact') chain.setLineHeight(`${Math.round(clamp(paraLinePt.value, 1, 500, 20) * 2) / 2}pt`)
  else chain.setLineHeight(mode)
  const before = paraBefore.value === '' ? null : clamp(paraBefore.value, 0, 200, 0)
  const after = paraAfter.value === '' ? null : clamp(paraAfter.value, 0, 200, 0)
  chain.setBlockSpacing({ spacingBefore: before, spacingAfter: after }).run()
  paragraphDialog.close()
  syncToolbar()
})

/* ---------------- 页面设置对话框 ---------------- */

const pageSetupDialog = document.querySelector('#pageSetupDialog')
const setupPageSize = document.querySelector('#setupPageSize')
const setupOrientation = document.querySelector('#setupOrientation')
const setupMarginPreset = document.querySelector('#setupMarginPreset')
const setupBackground = document.querySelector('#setupBackground')
const setupPageNumber = document.querySelector('#setupPageNumber')
const setupHeaderText = document.querySelector('#setupHeaderText')
const setupFooterText = document.querySelector('#setupFooterText')
const setupHeaderFooterAlign = document.querySelector('#setupHeaderFooterAlign')
const setupHeaderFooterSize = document.querySelector('#setupHeaderFooterSize')
const setupLineBreaking = document.querySelector('#setupLineBreaking')
const setupReadingMode = document.querySelector('#setupReadingMode')
const setupMarginInputs = {}
for (const side of ['top', 'right', 'bottom', 'left']) {
  setupMarginInputs[side] = document.querySelector(`#setupMargin${side[0].toUpperCase()}${side.slice(1)}`)
}

function fillSetupMargins (margins) {
  for (const side of ['top', 'right', 'bottom', 'left']) {
    setupMarginInputs[side].value = margins[side]
  }
}

function openPageSetupDialog () {
  const margins = currentMargins()
  setupPageSize.value = pageSetup.size
  setupOrientation.value = pageSetup.orientation
  setupMarginPreset.value = pageSetup.margin
  fillSetupMargins(margins)
  setupBackground.value = pageSetup.background
  setupPageNumber.value = pageSetup.pageNumber
  setupHeaderText.value = pageSetup.headerText
  setupFooterText.value = pageSetup.footerText
  setupHeaderFooterAlign.value = pageSetup.headerFooterAlign
  setupHeaderFooterSize.value = pageSetup.headerFooterFontSize
  setupLineBreaking.value = pageSetup.lineBreaking
  setupReadingMode.value = pageGapCollapsed ? 'reading' : 'pages'
  if (!pageSetupDialog.open) pageSetupDialog.showModal()
}

document.querySelector('#btnPageSetup').addEventListener('click', openPageSetupDialog)
document.querySelectorAll('[data-page-setup]').forEach((button) => {
  button.addEventListener('click', openPageSetupDialog)
})
document.querySelector('#btnCancelPageSetup').addEventListener('click', () => pageSetupDialog.close())

setupMarginPreset.addEventListener('change', () => {
  if (setupMarginPreset.value === 'custom') return
  const preset = PAGE_MARGINS[setupMarginPreset.value]
  if (preset) fillSetupMargins(preset)
})
for (const input of Object.values(setupMarginInputs)) {
  input.addEventListener('input', () => {
    if (setupMarginPreset.value !== 'custom') setupMarginPreset.value = 'custom'
  })
}

document.querySelector('#quickPageNumber').addEventListener('change', (event) => {
  setPageSetup({ pageNumber: event.target.value })
})

document.querySelector('#pageSetupForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const margins = {}
  for (const side of ['top', 'right', 'bottom', 'left']) {
    margins[side] = clamp(setupMarginInputs[side].value, 0, 10, 2.54)
  }
  setPageSetup({
    size: setupPageSize.value,
    orientation: setupOrientation.value,
    margin: setupMarginPreset.value,
    margins,
    background: setupBackground.value,
    pageNumber: setupPageNumber.value,
    headerText: setupHeaderText.value,
    footerText: setupFooterText.value,
    headerFooterAlign: setupHeaderFooterAlign.value,
    headerFooterFontSize: setupHeaderFooterSize.value,
    lineBreaking: setupLineBreaking.value
  })
  setReadingMode(setupReadingMode.value === 'reading')
  pageSetupDialog.close()
})

/* ---------------- 详细工具栏侧板 ---------------- */

const toolDetailEl = document.querySelector('#toolDetail')
const btnRibbonExpand = document.querySelector('#btnRibbonExpand')
const detailLineHeightSel = document.querySelector('#detailLineHeight')
const detailBeforeInput = document.querySelector('#detailBefore')
const detailAfterInput = document.querySelector('#detailAfter')
const detailPageNumberSel = document.querySelector('#detailPageNumber')
const detailBlockSel = document.querySelector('#detailBlock')
const detailColorInput = document.querySelector('#detailColor')
const detailHighlightInput = document.querySelector('#detailHighlight')

const TOOL_DETAIL_WIDTH = 340

function positionToolDetail () {
  if (!toolDetailEl || toolDetailEl.hidden) return
  const ribbon = document.querySelector('#ribbon').getBoundingClientRect()
  const paper = document.querySelector('.paper')
  const paperWidth = paper ? paper.getBoundingClientRect().width : 794
  const panelWidth = toolDetailEl.offsetWidth || TOOL_DETAIL_WIDTH
  // 右侧停靠后正文还有地方放整张纸，才停靠；否则用带边距的浮动卡片。
  // 不留额外呼吸宽度：1160 的窗口刚好能放下 A4 + 340 侧板，CI 里窗口
  // 可能比声明的 inner_size 少几像素，留 20px 会把这种情况误判成浮动。
  const docked = window.innerWidth >= paperWidth + panelWidth
  document.body.classList.toggle('tool-detail-docked', docked)
  document.body.classList.toggle('tool-detail-floating', !docked)
  toolDetailEl.style.top = `${ribbon.bottom + (docked ? 0 : 8)}px`
}

function syncDetailControls () {
  if (!toolDetailEl || toolDetailEl.hidden) return
  const textStyle = editor.getAttributes('textStyle')
  detailFontSel.value = textStyle.fontFamily || ''
  detailFontSizeSel.value = textStyle.fontSize ? textStyle.fontSize.replace('pt', '') : ''
  const block = currentBlockAttributes()
  const lineHeight = block.lineHeight == null ? '' : String(block.lineHeight)
  const exact = /^([\d.]+)pt$/i.exec(lineHeight)
  syncDynamicOption(
    detailLineHeightSel,
    lineHeight,
    exact ? `固定值 ${Number(exact[1])} 磅` : `${lineHeight} 倍`
  )
  if (editor.isActive('heading', { level: 1 })) detailBlockSel.value = 'h1'
  else if (editor.isActive('heading', { level: 2 })) detailBlockSel.value = 'h2'
  else if (editor.isActive('heading', { level: 3 })) detailBlockSel.value = 'h3'
  else detailBlockSel.value = 'paragraph'
  detailBeforeInput.value = Number.isFinite(block.spacingBefore) ? block.spacingBefore : ''
  detailAfterInput.value = Number.isFinite(block.spacingAfter) ? block.spacingAfter : ''
  detailPageNumberSel.value = pageSetup.pageNumber
  detailColorInput.value = normalizeHexColor(textStyle.color) || '#000000'
  detailHighlightInput.value = normalizeHexColor(editor.getAttributes('highlight').color) || '#ffff00'
}

function openToolDetail () {
  toolDetailEl.hidden = false
  document.body.classList.add('tool-detail-open')
  btnRibbonExpand.classList.add('active')
  btnRibbonExpand.setAttribute('aria-expanded', 'true')
  positionToolDetail()
  syncDetailControls()
}

function closeToolDetail () {
  toolDetailEl.hidden = true
  document.body.classList.remove('tool-detail-open', 'tool-detail-docked', 'tool-detail-floating')
  btnRibbonExpand.classList.remove('active')
  btnRibbonExpand.setAttribute('aria-expanded', 'false')
}

btnRibbonExpand.addEventListener('click', () => {
  if (toolDetailEl.hidden) openToolDetail()
  else closeToolDetail()
})
document.querySelector('#btnToolDetailClose').addEventListener('click', closeToolDetail)
window.addEventListener('resize', positionToolDetail)
new ResizeObserver(positionToolDetail).observe(document.querySelector('#ribbon'))
const detailPaperEl = document.querySelector('.paper')
if (detailPaperEl) new ResizeObserver(positionToolDetail).observe(detailPaperEl)

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || toolDetailEl.hidden) return
  if (document.querySelector('dialog[open]')) return
  closeToolDetail()
})

detailFontSel.addEventListener('change', () => {
  const chain = editor.chain().focus()
  if (detailFontSel.value) chain.setFontFamily(detailFontSel.value)
  else chain.unsetFontFamily()
  chain.run()
})
detailFontSizeSel.addEventListener('change', () => {
  const chain = editor.chain().focus()
  if (detailFontSizeSel.value) chain.setFontSize(`${detailFontSizeSel.value}pt`)
  else chain.unsetFontSize()
  chain.run()
})
detailBlockSel.addEventListener('change', () => {
  const chain = editor.chain().focus()
  if (detailBlockSel.value === 'paragraph') chain.setParagraph()
  else chain.setHeading({ level: Number(detailBlockSel.value.slice(1)) })
  chain.run()
})
detailLineHeightSel.addEventListener('change', () => {
  editor.chain().focus().setLineHeight(detailLineHeightSel.value || null).run()
})
detailBeforeInput.addEventListener('change', () => {
  editor.chain().focus().setBlockSpacing({
    spacingBefore: detailBeforeInput.value === '' ? null : detailBeforeInput.value
  }).run()
})
detailAfterInput.addEventListener('change', () => {
  editor.chain().focus().setBlockSpacing({
    spacingAfter: detailAfterInput.value === '' ? null : detailAfterInput.value
  }).run()
})
detailPageNumberSel.addEventListener('change', () => {
  setPageSetup({ pageNumber: detailPageNumberSel.value })
})
detailColorInput.addEventListener('change', () => {
  editor.chain().focus().setColor(detailColorInput.value).run()
})
detailHighlightInput.addEventListener('change', () => {
  editor.chain().focus().setHighlight({ color: detailHighlightInput.value }).run()
})
document.querySelector('#detailOpenParagraph').addEventListener('click', openParagraphDialog)
document.querySelector('#detailOpenPageSetup').addEventListener('click', openPageSetupDialog)
document.querySelector('#detailFind').addEventListener('click', () => document.querySelector('#btnFind').click())
document.querySelector('#detailReplace').addEventListener('click', () => document.querySelector('#btnReplace').click())

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

function runCommandButton (btn) {
  if (!btn) return
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
    openImageEditor(imagePosFromSelection())
  }
  syncToolbar()
}

document.querySelector('#ribbon').addEventListener('click', (e) => {
  const btn = e.target.closest('.tbtn')
  if (!btn || btn.id === 'btnFontColor' || btn.id === 'btnHighlight') return
  runCommandButton(btn)
})

document.querySelector('#toolDetail').addEventListener('click', (e) => {
  const btn = e.target.closest('.tbtn')
  if (!btn) return
  runCommandButton(btn)
})

function insertPageBreak () {
  const chain = editor.chain().focus()
  if (editor.state.selection.node) chain.setTextSelection(editor.state.selection.to)
  chain.insertContent([{ type: 'pageBreak' }, { type: 'paragraph' }]).run()
}

// 优先取 text/html 交给 ProseMirror 的粘贴管线，格式和 Ctrl+V 一致；只有纯文本时走
// pasteText。读不到再退回 Chromium 原生粘贴，仍失败就提示快捷键（WKWebView 上可能被拒）。
async function pasteFromClipboard () {
  editor.commands.focus()
  let html = ''
  let text = ''
  try {
    const items = await navigator.clipboard.read()
    for (const item of items) {
      if (!html && item.types.includes('text/html')) {
        html = await (await item.getType('text/html')).text()
      }
      if (!text && item.types.includes('text/plain')) {
        text = await (await item.getType('text/plain')).text()
      }
    }
  } catch {
    // 权限被拒或剪贴板为空：继续走下面的兜底
  }
  if (html) editor.view.pasteHTML(html)
  else if (text) editor.view.pasteText(text)
  else if (!document.execCommand('paste')) {
    showStatus(isMac ? '无法读取剪贴板，请按 ⌘V 粘贴' : '无法读取剪贴板，请按 Ctrl+V 粘贴')
    return
  }
  editor.view.focus()
}

const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp']
const IMAGE_PATH_PATTERN = /\.(png|jpg|jpeg|gif|bmp)$/i
function imageMime (extension) {
  return extension === 'jpg' ? 'image/jpeg' : `image/${extension}`
}

// 正文可用像素宽度：纸张 21cm 去掉左右页边距，按 96dpi（1cm ≈ 37.795px）折算。
// 直接用编辑器 DOM 实测，窗口缩放 / 自定义页边距都跟得上
function contentColumnWidth () {
  const width = editor?.view?.dom?.clientWidth
  return width > 0 ? width : 600
}

// 一张图放进页面时该多大：原图按比例缩到不超过正文栏宽。
// 以前插入时不写尺寸，节点视图又按原图像素铺开，1080px 的图直接顶出纸外。
// 返回的是「完整原图的显示尺寸」（面板里那一栏就是这个），可见尺寸由裁剪比例算
function fittedFullSize (natural) {
  if (!natural?.width || !natural?.height) return { width: null, height: null }
  const column = contentColumnWidth()
  if (natural.width <= column) return { width: natural.width, height: natural.height }
  const scale = column / natural.width
  return {
    width: Math.max(1, Math.round(natural.width * scale)),
    height: Math.max(1, Math.round(natural.height * scale))
  }
}

function naturalSizeOfSource (src) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => resolve({ width: image.naturalWidth || 0, height: image.naturalHeight || 0 })
    image.onerror = () => resolve({ width: 0, height: 0 })
    image.src = src
  })
}

// 插入图片：先读原图尺寸，按正文栏宽等比缩放后写入 width/height。
// 「恢复原始大小」回到的也是这个尺寸，所以它永远落在页面里
async function insertImageAt (src, alt) {
  const natural = await naturalSizeOfSource(src)
  const size = fittedFullSize(natural)
  editor.chain().focus().insertContent({
    type: 'image',
    attrs: { src, alt, width: size.width, height: size.height }
  }).run()
}

async function insertImageFromPath (filePath) {
  const data = await fileApi.readFile(filePath, true)
  const extension = filePath.split('.').pop().toLowerCase()
  await insertImageAt(`data:${imageMime(extension)};base64,${data}`, fileNameFromPath(filePath))
}

async function insertImage () {
  const filePath = await fileApi.showOpenDialog([{ name: '图片', extensions: IMAGE_EXTENSIONS }])
  if (!filePath) return
  try {
    await insertImageFromPath(filePath)
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
  showStatus(localizeShortcutText('已复制格式；选中目标后点“格式刷”或按 Ctrl+Shift+V 应用'))
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

/* ---------------- 图片编辑面板 ---------------- */

// 右侧悬浮抽屉：进入编辑时记下原始属性；所有改动实时写进文档（addToHistory:false），
// 正文重排和 DOCX 导出看到的都是最终效果。完成 / 取消时才决定历史栈怎么走。
const imagePanel = document.querySelector('#imagePanel')
const imageDim = document.querySelector('#imageDim')
const panelWidthInput = document.querySelector('#panelImageWidth')
const panelHeightInput = document.querySelector('#panelImageHeight')
const panelLockRatio = document.querySelector('#panelImageLockRatio')
const panelAlign = document.querySelector('#panelImageAlign')
const panelWrap = document.querySelector('#panelImageWrap')
const panelCropInputs = {
  top: document.querySelector('#panelCropTop'),
  right: document.querySelector('#panelCropRight'),
  bottom: document.querySelector('#panelCropBottom'),
  left: document.querySelector('#panelCropLeft')
}

let imageEdit = null
let imagePreviewFrame = 0
let imagePreviewAttrs = null
let imagePerfFrames = 0

function imagePosFromSelection () {
  const selection = editor.state.selection
  if (selection.node?.type.name === 'image') return selection.from
  return null
}

function imageDom (pos) {
  try {
    return editor.view.nodeDOM(pos)
  } catch {
    return null
  }
}

function imageFrameEl (pos) {
  const dom = imageDom(pos)
  if (!dom) return null
  return dom.querySelector?.('[data-resize-container]') || dom.closest?.('[data-resize-container]') || dom
}

function imageImgEl (pos) {
  return imageDom(pos)?.querySelector?.('img') || null
}

// 面板悬浮在右侧、不挤占纸张宽度，所以进入编辑只多做一件事：
// 给工作区补左右等宽的内边距（多出横向滚动余量），再把 scrollLeft 调回来，
// 让纸张在屏幕上的位置和进入前完全一致。只有图片确实被面板压住时才继续横滚。
function revealImageAbovePanel (pos, paperLeftBefore) {
  const paper = document.querySelector('.paper')
  if (!paper) return
  const paperLeft = paper.getBoundingClientRect().left
  // 补内边距后纸张会往右移，用横向滚动抵消，位置一秒不变
  if (paperLeftBefore != null) workspaceEl.scrollLeft += paperLeft - paperLeftBefore
  const frame = imageFrameEl(pos)
  if (!frame) return
  const imageBox = frame.getBoundingClientRect()
  const panelBox = imagePanel.getBoundingClientRect()
  const workspaceBox = workspaceEl.getBoundingClientRect()
  const overlap = imageBox.right - (panelBox.left - 16)
  if (overlap > 0) workspaceEl.scrollLeft += overlap
  if (imageBox.top < workspaceBox.top + 8) {
    workspaceEl.scrollTop -= workspaceBox.top + 8 - imageBox.top
  } else if (imageBox.top > workspaceBox.bottom - 40) {
    workspaceEl.scrollTop += imageBox.top - workspaceBox.top - 8
  }
}

// 变暗层按图片外框切成四块铺满窗口：表格单元格的 overflow 裁不到它，
// 点在上面也确实落在遮罩本身（行为统一交给 onEditorBackdropClick）
function syncImageDim () {
  if (!imageEdit || imagePanel.hidden) return
  const frame = imageFrameEl(imageEdit.pos)
  if (!frame) {
    imageDim.hidden = true
    return
  }
  const box = frame.getBoundingClientRect()
  const width = window.innerWidth
  const height = window.innerHeight
  const left = Math.min(Math.max(0, box.left), width)
  const right = Math.min(Math.max(left, box.right), width)
  const top = Math.min(Math.max(0, box.top), height)
  const bottom = Math.min(Math.max(top, box.bottom), height)
  const parts = {
    top: [0, 0, width, top],
    bottom: [0, bottom, width, Math.max(0, height - bottom)],
    left: [0, top, left, Math.max(0, bottom - top)],
    right: [right, top, Math.max(0, width - right), Math.max(0, bottom - top)]
  }
  imageDim.hidden = false
  for (const part of imageDim.querySelectorAll('.image-dim-part')) {
    const rect = parts[part.dataset.side]
    part.style.left = `${rect[0]}px`
    part.style.top = `${rect[1]}px`
    part.style.width = `${rect[2]}px`
    part.style.height = `${rect[3]}px`
  }
}

// 面板里填的是原图显示尺寸；文档里的 width/height 记的是裁剪后的可见尺寸（V3 起）
function setPanelFieldValues (attrs) {
  const img = imageImgEl(imageEdit?.pos ?? -1)
  const natural = {
    width: img?.naturalWidth || attrNumber(attrs.width) || 300,
    height: img?.naturalHeight || attrNumber(attrs.height) || 200
  }
  const frame = imageCropFrame(attrs, natural)
  const fullWidth = Math.round(frame.innerWidth || natural.width)
  const fullHeight = Math.round(frame.innerHeight || natural.height)
  panelWidthInput.value = fullWidth
  panelHeightInput.value = fullHeight
  // 比例必须取「完整图的宽高比」。裁过的图片按可见尺寸算出来的比例是偏的，
  // 之后勾着「锁定比例」改宽，高就被算成错的值（§4.4 裁剪后再调尺寸图会变样）
  const naturalWidth = img?.naturalWidth || fullWidth
  const naturalHeight = img?.naturalHeight || fullHeight
  imageEdit.ratio = naturalWidth > 0 && naturalHeight > 0 ? naturalWidth / naturalHeight : 1
  // 输入框被塞进了乱七八糟的东西时，按这个兜底，别让宽度变成 NaN
  imageEdit.panelBaseWidth = fullWidth
  imageEdit.panelBaseHeight = fullHeight
  panelLockRatio.checked = true
  const crop = attrs.crop || {}
  panelAlign.value = attrs.align || 'left'
  panelWrap.value = attrs.wrap || 'none'
  for (const side of ['top', 'right', 'bottom', 'left']) {
    panelCropInputs[side].value = Number(crop[side]) || 0
  }
}

function attrNumber (value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// 撤销栈深度：selftest 用它验证「取消不动栈、完成只加一步」
function historyState () {
  const state = editor.state
  return { undo: undoDepth(state), redo: redoDepth(state) }
}
// 给自测脚本用的小接口（不对外）
window.__wlImageEditor = {
  historyState,
  isEditing: () => !!imageEdit,
  open: (pos) => openImageEditor(pos),
  finish: () => finishImageEditing(),
  cancel: () => cancelImageEditing(),
  panel: () => imagePanel,
  isCropping: () => inCropMode(),
  crop: () => enterCropMode(),
  applyCrop: () => applyCropMode(),
  cancelCrop: () => cancelCropMode(),
  setCropDraft: (draft) => {
    if (!inCropMode()) return false
    imageEdit.crop.draft = { ...imageEdit.crop.draft, ...draft }
    syncCropOverlay()
    return true
  },
  setCropRatio: (mode) => setCropRatio(mode),
  cropDraft: () => currentCropDraft()
}

// 三种入口（双击 / 选中后 Enter / 右键「图片设置…」）都走这一个函数
function openImageEditor (pos = null) {
  const target = pos == null ? imagePosFromSelection() : pos
  const node = target == null ? null : editor.state.doc.nodeAt(target)
  if (!node || node.type.name !== 'image') {
    showStatus('请先在文档中单击选中图片')
    return
  }
  // 已经在编辑另一张图：先把上一张收尾
  if (imageEdit) finishImageEditing()
  imageEdit = {
    pos: target,
    original: { ...node.attrs },
    ratio: 1,
    dirty,
    degraded: false,
    pending: null
  }
  imagePreviewAttrs = null
  imagePerfFrames = 0
  const selection = editor.state.selection
  if (selection.node == null || selection.from !== target) {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, target)))
  }
  setPanelFieldValues(node.attrs)
  imageFrameEl(target)?.classList.add('image-editing')
  imagePanel.hidden = false
  // 记下纸张当前的屏幕位置：补内边距后要把它还原，图片才不会“跳”
  const paperLeftBefore = document.querySelector('.paper')?.getBoundingClientRect().left ?? null
  workspaceEl.classList.add('image-edit-mode')
  imageDim.addEventListener('click', onEditorBackdropClick)
  imageDim.addEventListener('wheel', onImageDimWheel, { passive: true })
  document.addEventListener('keydown', onImagePanelKeydown, true)
  // 编辑期间锁住正文输入：免得输入法、撤销栈和实时预览互相干扰。
  // 第二个参数 false = 不触发 update，否则进编辑这一下就会把文档标成未保存
  editor.setEditable(false, false)
  // 实时预览会一直改文档，自动备份先停，退出时再排
  clearTimeout(autosaveTimer)
  // 下面那次 rAF 里的自动聚焦不算「用户主动用数字框」，别让它把 C 挡掉
  panelFocusArmedAt = Date.now()
  requestAnimationFrame(() => {
    if (!imageEdit) return
    revealImageAbovePanel(imageEdit.pos, paperLeftBefore)
    if (inCropMode()) syncCropOverlay()
    else syncImageDim()
    // 焦点放在面板本体，而不是「宽」：数字框被自动聚焦时，用户手还在输入法里
    // 的话，接下来的拼音会被直接写进宽度（§4.4「宽度值后面多出一个 c」）。
    // 面板拿到焦点，C 就还能被 onImagePanelKeydown 收走进裁剪
    imagePanel.focus({ preventScroll: true })
  })
  showStatus(`正在编辑图片：${isMac ? '⌘↵' : 'Ctrl+Enter'} 完成，Esc 取消`, 0)
}

function onImageDimWheel (event) {
  // 遮罩盖在正文上，滚轮要转给工作区
  workspaceEl.scrollTop += event.deltaY
  if (inCropMode()) syncCropOverlay()
  else syncImageDim()
}

// 实时预览：一帧最多写一次；连续 3 帧超过 50ms 就降级成松手 / 失焦才应用
function scheduleImagePreview (attrs) {
  if (!imageEdit) return
  if (imageEdit.degraded) {
    imageEdit.pending = attrs
    return
  }
  imagePreviewAttrs = attrs
  if (imagePreviewFrame) return
  const started = performance.now()
  imagePreviewFrame = requestAnimationFrame(() => {
    imagePreviewFrame = 0
    const elapsed = performance.now() - started
    imagePerfFrames = elapsed > 50 ? imagePerfFrames + 1 : 0
    if (imagePerfFrames >= 3 && imageEdit && !imageEdit.degraded) {
      imageEdit.degraded = true
      showStatus('文档较大，已改为松手后应用', 0)
    }
    const pending = imagePreviewAttrs
    imagePreviewAttrs = null
    if (pending) applyImagePreview(pending)
  })
}

function applyImagePreview (attrs) {
  if (!imageEdit) return
  const pos = imageEdit.pos
  const node = editor.state.doc.nodeAt(pos)
  if (!node || node.type.name !== 'image') return
  // addToHistory:false：预览不进撤销栈，完成时才合成一步
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...node.attrs, ...attrs }).setMeta('addToHistory', false))
  if (inCropMode()) syncCropOverlay()
  else syncImageDim()
}

function flushImagePreview () {
  if (!imageEdit) return
  // 还没落盘的帧马上补上（降级模式下松手 / 失焦靠这个）
  if (imagePreviewFrame) {
    cancelAnimationFrame(imagePreviewFrame)
    imagePreviewFrame = 0
    const pending = imagePreviewAttrs
    imagePreviewAttrs = null
    if (pending) applyImagePreview(pending)
  }
  if (!imageEdit.pending) return
  const pending = imageEdit.pending
  imageEdit.pending = null
  applyImagePreview(pending)
}

function panelAttributes () {
  const crop = {}
  for (const side of ['top', 'right', 'bottom', 'left']) {
    crop[side] = clamp(panelCropInputs[side].value, 0, 95, 0)
  }
  if (crop.top + crop.bottom >= 100 || crop.left + crop.right >= 100) {
    showStatus('裁剪比例过大：上下或左右之和必须小于 100%', 0)
    return null
  }
  // 输入框可能残留字母（输入法 / 粘贴进来的「1080c」）：那是脏值。
  // 清空了也一样——数字框被 IME 塞进非法字符时浏览器会自己清空，按面板刚打开时的尺寸兜底
  const readSize = (input, fallback) => {
    const n = Number(input.value.trim())
    return Number.isFinite(n) && n > 0 ? clamp(n, 8, 5000, fallback) : fallback
  }
  const fullWidth = readSize(panelWidthInput, imageEdit?.panelBaseWidth || 300)
  const fullHeight = readSize(panelHeightInput, imageEdit?.panelBaseHeight || 200)
  // 输入框里是原图尺寸，写进文档的必须是裁剪后的可见尺寸（和 Word 一致）
  const visibleX = 1 - (crop.left + crop.right) / 100
  const visibleY = 1 - (crop.top + crop.bottom) / 100
  return {
    width: fullWidth === null ? null : Math.max(1, Math.round(fullWidth * visibleX)),
    height: fullHeight === null ? null : Math.max(1, Math.round(fullHeight * visibleY)),
    align: panelAlign.value || null,
    wrap: panelWrap.value === 'none' ? null : panelWrap.value,
    crop
  }
}

function updatePanelFromInputs () {
  const attrs = panelAttributes()
  if (attrs) scheduleImagePreview(attrs)
}

function syncPanelSize (source) {
  if (!panelLockRatio.checked || !imageEdit) return
  const ratio = imageEdit.ratio
  if (!(ratio > 0)) return
  const width = Number.parseFloat(panelWidthInput.value)
  const height = Number.parseFloat(panelHeightInput.value)
  if (source === panelWidthInput && Number.isFinite(width) && width > 0) {
    panelHeightInput.value = Math.round(width / ratio)
  } else if (source === panelHeightInput && Number.isFinite(height) && height > 0) {
    panelWidthInput.value = Math.round(height * ratio)
  }
}

for (const input of [panelWidthInput, panelHeightInput]) {
  input.addEventListener('input', () => {
    if (!imageEdit) return
    syncPanelSize(input)
    updatePanelFromInputs()
  })
  input.addEventListener('change', flushImagePreview)
  input.addEventListener('blur', flushImagePreview)
}

panelLockRatio.addEventListener('change', () => {
  if (!imageEdit) return
  if (panelLockRatio.checked) {
    const width = Number.parseFloat(panelWidthInput.value)
    const height = Number.parseFloat(panelHeightInput.value)
    if (width > 0 && height > 0) imageEdit.ratio = width / height
    syncPanelSize(panelWidthInput)
  }
})

for (const select of [panelAlign, panelWrap]) {
  select.addEventListener('change', () => {
    if (!imageEdit) return
    updatePanelFromInputs()
    flushImagePreview()
  })
}

for (const side of ['top', 'right', 'bottom', 'left']) {
  panelCropInputs[side].addEventListener('input', () => {
    if (!imageEdit) return
    updatePanelFromInputs()
  })
  panelCropInputs[side].addEventListener('change', flushImagePreview)
  panelCropInputs[side].addEventListener('blur', flushImagePreview)
}

/* ---------------- 裁剪交互（V5b） ---------------- */

// 裁剪状态里图片显示完整原图：节点视图本来只露裁掉后的部分，
// 所以这里在图片上层按同一比例铺一张完整原图，再把裁剪框和四周暗色盖上去。
// 框里的像素和下面完全重合，看到的只是“多出来一圈”。
const cropOverlay = document.querySelector('#cropOverlay')
const cropFrameEl = document.querySelector('#cropFrame')
const cropImageEl = document.querySelector('#cropImage')
const cropRatioSelect = document.querySelector('#panelCropRatio')
const CROP_MIN_PX = 10

let cropDrag = null

function inCropMode () {
  return !!imageEdit?.crop
}

function currentCropDraft () {
  const crop = imageEdit?.crop?.draft
  return crop ? { ...crop } : { top: 0, right: 0, bottom: 0, left: 0 }
}

function cropAspect () {
  const mode = imageEdit?.crop?.ratio
  if (!mode || mode === 'free') return null
  if (mode === 'natural') {
    const img = imageImgEl(imageEdit.pos)
    if (img?.naturalWidth && img?.naturalHeight) return img.naturalWidth / img.naturalHeight
    const attrs = editor.state.doc.nodeAt(imageEdit.pos)?.attrs || {}
    const width = attrNumber(attrs.width)
    const height = attrNumber(attrs.height)
    return width && height ? width / height : null
  }
  const [a, b] = mode.split(':')
  const aspect = Number(a) / Number(b)
  return aspect > 0 ? aspect : null
}

// 百分比 ↔ 图片上的像素：框的边都相对完整原图的矩形算
function draftFromEdges (edges, rect) {
  const clampPct = (value) => Math.min(100, Math.max(0, value))
  return {
    left: clampPct(edges.left / rect.width * 100),
    right: clampPct((rect.width - edges.right) / rect.width * 100),
    top: clampPct(edges.top / rect.height * 100),
    bottom: clampPct((rect.height - edges.bottom) / rect.height * 100)
  }
}

function edgesFromDraft (draft, rect) {
  return {
    left: rect.width * draft.left / 100,
    top: rect.height * draft.top / 100,
    right: rect.width * (1 - draft.right / 100),
    bottom: rect.height * (1 - draft.bottom / 100)
  }
}

function enterCropMode () {
  if (!imageEdit || imageEdit.crop) return
  // 起始裁剪框 = 面板里当前的四个百分比（也就是文档当前的裁剪）
  const draft = {}
  for (const side of ['top', 'right', 'bottom', 'left']) {
    draft[side] = clamp(panelCropInputs[side].value, 0, 95, 0)
  }
  imageEdit.crop = {
    draft,
    ratio: 'free',
    rect: null,
    // 进裁剪前面板里的「完整原图尺寸」：应用裁剪后回到这个值，
    // 可见尺寸自然按裁掉的比例缩小（和 Word 一样，裁多少小多少）
    fullWidth: clamp(panelWidthInput.value, 8, 5000, 0) || imageEdit.panelBaseWidth || 0,
    fullHeight: clamp(panelHeightInput.value, 8, 5000, 0) || imageEdit.panelBaseHeight || 0
  }
  cropRatioSelect.value = 'free'
  const attrs = editor.state.doc.nodeAt(imageEdit.pos)?.attrs
  cropImageEl.src = attrs?.src || ''
  // 编辑态的变暗层让位给裁剪自己的遮罩
  imageDim.hidden = true
  cropOverlay.hidden = false
  imageFrameEl(imageEdit.pos)?.classList.add('image-cropping')
  cropOverlay.addEventListener('wheel', onImageDimWheel, { passive: true })
  syncCropOverlay()
  requestAnimationFrame(() => {
    if (!inCropMode()) return
    syncCropOverlay()
    cropFrameEl.focus({ preventScroll: true })
  })
  showStatus(`裁剪中：拖边角或方向键调整，Enter 应用，Esc 取消`, 0)
}

function leaveCropMode () {
  if (!imageEdit?.crop) return
  if (cropDrag) endCropDrag()
  imageEdit.crop = null
  cropOverlay.hidden = true
  cropOverlay.removeEventListener('wheel', onImageDimWheel)
  for (const frame of document.querySelectorAll('.ProseMirror [data-resize-container].image-cropping')) {
    frame.classList.remove('image-cropping')
  }
  imageDim.hidden = true
  syncImageDim()
  if (imageEdit) cropRatioSelect.value = 'free'
}

// 应用：回到编辑状态，裁剪百分比写回面板 → 走同一条实时预览，
// width/height 仍按 V3 的「可见区域 = 原尺寸 × 未裁掉的比例」重算
function applyCropMode () {
  if (!inCropMode()) return false
  const draft = currentCropDraft()
  const crop = {}
  for (const side of ['top', 'right', 'bottom', 'left']) crop[side] = Math.round(draft[side])
  if (crop.top + crop.bottom >= 100 || crop.left + crop.right >= 100) {
    // 极端小图兜底：至少留一条边
    if (crop.top + crop.bottom >= 100) crop.bottom = Math.max(0, 99 - crop.top)
    if (crop.left + crop.right >= 100) crop.right = Math.max(0, 99 - crop.left)
  }
  // 面板尺寸框保持进裁剪前的完整尺寸；写进文档的可见尺寸由 panelAttributes 按
  // 「可见 = 完整 × 未裁掉的比例」算出来，所以裁多少就小多少
  if (imageEdit.crop?.fullWidth > 0) panelWidthInput.value = Math.round(imageEdit.crop.fullWidth)
  if (imageEdit.crop?.fullHeight > 0) panelHeightInput.value = Math.round(imageEdit.crop.fullHeight)
  leaveCropMode()
  for (const side of ['top', 'right', 'bottom', 'left']) panelCropInputs[side].value = crop[side]
  updatePanelFromInputs()
  flushImagePreview()
  showStatus('已应用裁剪', 4000)
  return true
}

function cancelCropMode () {
  if (!inCropMode()) return
  leaveCropMode()
  // 面板里那四个百分比一直没动，裁剪前的样子还在
  const attrs = editor.state.doc.nodeAt(imageEdit.pos)?.attrs || {}
  for (const side of ['top', 'right', 'bottom', 'left']) {
    panelCropInputs[side].value = Number(attrs.crop?.[side]) || 0
  }
  showStatus('已取消裁剪', 4000)
}

function syncCropOverlay () {
  if (!inCropMode()) return
  const img = imageImgEl(imageEdit.pos)
  if (!img) return
  const box = img.getBoundingClientRect()
  if (!box.width || !box.height) return
  const rect = { left: box.left, top: box.top, width: box.width, height: box.height }
  imageEdit.crop.rect = rect
  cropImageEl.style.left = `${rect.left}px`
  cropImageEl.style.top = `${rect.top}px`
  cropImageEl.style.width = `${rect.width}px`
  cropImageEl.style.height = `${rect.height}px`
  const edges = edgesFromDraft(imageEdit.crop.draft, rect)
  const frame = {
    left: rect.left + edges.left,
    top: rect.top + edges.top,
    width: Math.max(1, edges.right - edges.left),
    height: Math.max(1, edges.bottom - edges.top)
  }
  cropFrameEl.style.left = `${frame.left}px`
  cropFrameEl.style.top = `${frame.top}px`
  cropFrameEl.style.width = `${frame.width}px`
  cropFrameEl.style.height = `${frame.height}px`
  const right = frame.left + frame.width
  const bottom = frame.top + frame.height
  const shades = {
    top: [rect.left, rect.top, rect.width, frame.top - rect.top],
    bottom: [rect.left, bottom, rect.width, rect.top + rect.height - bottom],
    left: [rect.left, frame.top, frame.left - rect.left, frame.height],
    right: [right, frame.top, rect.left + rect.width - right, frame.height]
  }
  for (const part of cropOverlay.querySelectorAll('.crop-shade')) {
    const r = shades[part.dataset.shade]
    part.style.left = `${r[0]}px`
    part.style.top = `${r[1]}px`
    part.style.width = `${Math.max(0, r[2])}px`
    part.style.height = `${Math.max(0, r[3])}px`
  }
}

// 拖边 / 拖角：先按像素算边，再按比例约束，最后转回百分比。
// 拖角时对角固定（锚点），拖边时只动那一条边；固定比例下另一边跟着比例走：
// 拖左右边高度围绕中心，拖上下边宽度围绕中心。
function dragCropEdges (handle, base, dx, dy, rect) {
  const aspect = cropAspect()
  const W = rect.width
  const H = rect.height
  const minW = Math.min(CROP_MIN_PX, W)
  const minH = Math.min(CROP_MIN_PX, H)
  // 只数边：角的两条边都在，拖角时对角固定
  const movesLeft = handle === 'left' || handle === 'top-left' || handle === 'bottom-left'
  const movesRight = handle === 'right' || handle === 'top-right' || handle === 'bottom-right'
  const movesTop = handle === 'top' || handle === 'top-left' || handle === 'top-right'
  const movesBottom = handle === 'bottom' || handle === 'bottom-left' || handle === 'bottom-right'
  let left = base.left
  let right = base.right
  let top = base.top
  let bottom = base.bottom
  if (movesLeft) left = clamp(left + dx, 0, right - minW, left)
  if (movesRight) right = clamp(right + dx, left + minW, W, right)
  if (movesTop) top = clamp(top + dy, 0, bottom - minH, top)
  if (movesBottom) bottom = clamp(bottom + dy, top + minH, H, bottom)
  if (!aspect) return { left, right, top, bottom }

  if ((movesLeft || movesRight) && (movesTop || movesBottom)) {
    // 角：对角是锚点，宽先定，高按比例跟上，再受画框和最小尺寸约束
    const anchorX = movesLeft ? base.right : base.left
    const anchorY = movesTop ? base.bottom : base.top
    const maxW = movesLeft ? anchorX : W - anchorX
    const maxH = movesTop ? anchorY : H - anchorY
    let width = Math.min(right - left, maxW, maxH * aspect)
    width = Math.max(width, Math.min(minW, maxW), Math.min(minH * aspect, maxW))
    let height = width / aspect
    if (height > maxH) { height = maxH; width = height * aspect }
    left = movesLeft ? anchorX - width : anchorX
    right = movesLeft ? anchorX : anchorX + width
    top = movesTop ? anchorY - height : anchorY
    bottom = movesTop ? anchorY : anchorY + height
    return { left, right, top, bottom }
  }
  if (movesLeft || movesRight) {
    // 左右边：高度围绕原框中心缩放
    let width = right - left
    let height = width / aspect
    if (height > H) { height = H; width = height * aspect }
    const center = (base.top + base.bottom) / 2
    top = clamp(center - height / 2, 0, H - height, top)
    bottom = top + height
    // 被拖的边已经夹在画框里；另一条边跟着宽度走，可能贴出画框，这里再收一次
    if (movesLeft) {
      right = left + width
      if (right > W) { right = W; width = right - left; height = width / aspect; bottom = top + height }
    } else {
      left = right - width
      if (left < 0) { left = 0; width = right - left; height = width / aspect; bottom = top + height }
    }
    return { left, right, top, bottom }
  }
  // 上下边：宽度围绕原框中心缩放
  let height = bottom - top
  let width = height * aspect
  if (width > W) { width = W; height = width / aspect }
  const center = (base.left + base.right) / 2
  left = clamp(center - width / 2, 0, W - width, left)
  right = left + width
  if (movesTop) {
    bottom = top + height
    if (bottom > H) { bottom = H; height = bottom - top; width = height * aspect; right = left + width }
  } else {
    top = bottom - height
    if (top < 0) { top = 0; height = bottom - top; width = height * aspect; left = right - width }
  }
  return { left, right, top, bottom }
}

function onCropDragMove (event) {
  if (!cropDrag) return
  const rect = cropDrag.rect
  const dx = event.clientX - cropDrag.startX
  const dy = event.clientY - cropDrag.startY
  const edges = dragCropEdges(cropDrag.handle, cropDrag.base, dx, dy, rect)
  imageEdit.crop.draft = draftFromEdges(edges, rect)
  syncCropOverlay()
}

function endCropDrag () {
  if (!cropDrag) return
  cropDrag = null
  document.removeEventListener('pointermove', onCropDragMove)
  document.removeEventListener('pointerup', endCropDrag)
  document.removeEventListener('pointercancel', endCropDrag)
}

cropOverlay.addEventListener('pointerdown', (event) => {
  if (!inCropMode()) return
  // 遮罩和框内都吞掉点击，裁剪状态里不让下面的正文跟着动
  event.preventDefault()
  const handle = event.target.closest?.('[data-handle]')
  if (!handle || !imageEdit.crop.rect) {
    cropFrameEl.focus({ preventScroll: true })
    return
  }
  const rect = imageEdit.crop.rect
  cropDrag = {
    handle: handle.dataset.handle,
    startX: event.clientX,
    startY: event.clientY,
    base: edgesFromDraft(currentCropDraft(), rect),
    rect
  }
  handle.setPointerCapture?.(event.pointerId)
  document.addEventListener('pointermove', onCropDragMove)
  document.addEventListener('pointerup', endCropDrag)
  document.addEventListener('pointercancel', endCropDrag)
  handle.focus({ preventScroll: true })
})

// 手柄的方向键：每次 1px，Shift 10px
function nudgeCropHandle (handle, key, step) {
  if (!inCropMode() || !imageEdit.crop.rect) return
  const rect = imageEdit.crop.rect
  const base = edgesFromDraft(currentCropDraft(), rect)
  const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0
  const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0
  const edges = dragCropEdges(handle, base, dx, dy, rect)
  imageEdit.crop.draft = draftFromEdges(edges, rect)
  syncCropOverlay()
}

cropOverlay.addEventListener('keydown', (event) => {
  if (!inCropMode()) return
  const handle = event.target.closest?.('[data-handle]')
  if (!handle) {
    // 焦点在裁剪框本身（Tab 循环会落在这里）：方向键一并挪「右下角」，
    // 这样焦点进到裁剪层就立刻能操作，不用先去抓某个手柄
    if (event.target !== cropFrameEl) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    nudgeCropHandle('bottom-right', event.key, event.shiftKey ? 10 : 1)
    return
  }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  event.stopPropagation()
  nudgeCropHandle(handle.dataset.handle, event.key, event.shiftKey ? 10 : 1)
})

// 比例切换：以当前裁剪框中心为基准，取能放进原图的最大框
function setCropRatio (mode) {
  if (!inCropMode()) return
  const crop = imageEdit.crop
  crop.ratio = mode
  const aspect = cropAspect()
  if (!aspect) {
    syncCropOverlay()
    return
  }
  const rect = crop.rect
  if (!rect) return
  const draft = currentCropDraft()
  const centerX = (draft.left + (100 - draft.right)) / 2
  const centerY = (draft.top + (100 - draft.bottom)) / 2
  // 能放进原图的最大框：高度取「画框高」和「画框宽 ÷ 比例」中小的那个
  const height = Math.min(rect.height, rect.width / aspect)
  const width = height * aspect
  const left = Math.min(Math.max(0, rect.width * centerX / 100 - width / 2), rect.width - width)
  const top = Math.min(Math.max(0, rect.height * centerY / 100 - height / 2), rect.height - height)
  crop.draft = draftFromEdges({ left, top, right: left + width, bottom: top + height }, rect)
  syncCropOverlay()
}

cropRatioSelect.addEventListener('change', () => {
  if (!inCropMode()) {
    // 比例只在裁剪状态里有意义；面板里提前改就退回去
    cropRatioSelect.value = 'free'
    return
  }
  setCropRatio(cropRatioSelect.value)
})

document.querySelector('#btnPanelCropMode').addEventListener('click', () => enterCropMode())


// 「恢复原始大小」= 回到这张图刚插进来时的样子：按正文栏宽等比缩好的尺寸，
// 而不是原图像素（4K 截图按原样铺开会顶穿纸张，§4.4 的「恢复原始大小键也失效」）
function resetPanelSizeToNatural () {
  if (!imageEdit) return
  const img = imageImgEl(imageEdit.pos)
  const natural = { width: img?.naturalWidth || 0, height: img?.naturalHeight || 0 }
  const full = fittedFullSize(natural)
  // 面板里填的是完整原图尺寸；文档里写可见尺寸，按当前裁剪比例折算
  panelWidthInput.value = full.width || natural.width || ''
  panelHeightInput.value = full.height || natural.height || ''
  if (natural.width > 0 && natural.height > 0) imageEdit.ratio = natural.width / natural.height
  const crop = {}
  for (const side of ['top', 'right', 'bottom', 'left']) crop[side] = clamp(panelCropInputs[side].value, 0, 95, 0)
  const visibleX = 1 - (crop.left + crop.right) / 100
  const visibleY = 1 - (crop.top + crop.bottom) / 100
  const width = full.width ? Math.max(1, Math.round(full.width * visibleX)) : null
  const height = full.height ? Math.max(1, Math.round(full.height * visibleY)) : null
  scheduleImagePreview({ width, height })
  flushImagePreview()
}

document.querySelector('#btnPanelRestoreSize').addEventListener('click', () => {
  resetPanelSizeToNatural()
})

document.querySelector('#btnPanelReplaceImage').addEventListener('click', async () => {
  if (!imageEdit) return
  const filePath = await fileApi.showOpenDialog([{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp'] }])
  if (!filePath) return
  try {
    const data = await fileApi.readFile(filePath, true)
    const extension = filePath.split('.').pop().toLowerCase()
    const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`
    panelWidthInput.value = ''
    panelHeightInput.value = ''
    for (const side of ['top', 'right', 'bottom', 'left']) panelCropInputs[side].value = 0
    scheduleImagePreview({
      src: `data:${mime};base64,${data}`,
      alt: fileNameFromPath(filePath),
      width: null,
      height: null,
      crop: { top: 0, right: 0, bottom: 0, left: 0 }
    })
    flushImagePreview()
  } catch (error) {
    showStatus(`更换图片失败：${error.message}`, 0)
  }
})

document.querySelector('#btnPanelResetImage').addEventListener('click', () => {
  if (!imageEdit) return
  panelWrap.value = 'none'
  panelLockRatio.checked = true
  for (const side of ['top', 'right', 'bottom', 'left']) panelCropInputs[side].value = 0
  resetPanelSizeToNatural()
  // 对齐保持不变，只把裁剪、尺寸和环绕退回默认
  updatePanelFromInputs()
})

document.querySelector('#btnPanelDeleteImage').addEventListener('click', () => {
  if (!imageEdit) return
  const pos = imageEdit.pos
  // 先把属性还原（不进历史）再删节点：整次编辑只留一步撤销
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...imageEdit.original }).setMeta('addToHistory', false))
  closeImageEditorUI()
  editor.chain().focus().setNodeSelection(pos).deleteSelection().run()
  dirty = true
  updateDocumentState()
  showStatus('已删除图片')
})

document.querySelector('#btnPanelCancelImage').addEventListener('click', () => cancelImageEditing())
document.querySelector('#btnPanelDoneImage').addEventListener('click', () => finishImageEditing())

// 「点变暗区域」的行为只在这一处决定；调度要等用户确认是「完成」还是别的
function onEditorBackdropClick () {
  finishImageEditing()
}

// 完成：先不进历史地恢复原属性，再用一个进历史的事务写入最终属性 → 一次编辑只占一步撤销
function finishImageEditing () {
  if (!imageEdit) return
  // 还在裁剪里就先把裁剪落定（Enter 应用、Ctrl+Enter 也是一路到底）
  if (inCropMode()) applyCropMode()
  const { pos, original, dirty: beforeDirty } = imageEdit
  flushImagePreview()
  const node = imageNodeAt(pos)
  const finalAttrs = node ? { ...node.attrs } : null
  const changed = !!finalAttrs && imageAttrsChanged(original, finalAttrs)
  if (finalAttrs) {
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...original }).setMeta('addToHistory', false))
    if (changed) editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...finalAttrs }))
  }
  dirty = beforeDirty || changed
  updateDocumentState()
  closeImageEditor()
  showStatus(changed ? '已保存图片修改' : '图片未改动')
}

function cancelImageEditing () {
  if (!imageEdit) return
  const { pos, original, dirty: beforeDirty } = imageEdit
  // 不进历史地还原；dirty 也恢复成进入前的值
  const node = imageNodeAt(pos)
  if (node) {
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, null, { ...original }).setMeta('addToHistory', false))
  }
  dirty = beforeDirty
  updateDocumentState()
  closeImageEditor()
  showStatus('已取消图片编辑')
}

// 面板开着的时候文档可能被换掉（打开了别的文件），原来记的 pos 就失效了。
// 一律先确认那个位置真的还是一张图片，再拿它当图片节点用。
function imageNodeAt (pos) {
  if (pos == null || pos < 0 || pos > editor.state.doc.content.size) return null
  const node = editor.state.doc.nodeAt(pos)
  return node && node.type.name === 'image' ? node : null
}

// 只比较会影响文档的属性；crop 是对象，要按四个百分比比
function imageAttrsChanged (before, after) {
  if (!before || !after) return true
  const keys = ['width', 'height', 'align', 'wrap', 'src', 'alt', 'crop']
  return keys.some((key) => {
    if (key === 'crop') {
      const a = ['top', 'right', 'bottom', 'left'].map((side) => Number(before.crop?.[side]) || 0)
      const b = ['top', 'right', 'bottom', 'left'].map((side) => Number(after.crop?.[side]) || 0)
      return a.some((value, index) => value !== b[index])
    }
    return (before[key] ?? null) !== (after[key] ?? null)
  })
}

// 只收界面：属性还原由调用方按自己的语义先做掉
function closeImageEditorUI () {
  if (!imageEdit) return
  // 裁剪层还没有落定就跟着一起收掉（取消编辑 = 裁剪也取消）
  if (inCropMode()) leaveCropMode()
  // 退出时把横向滚动和补出来的内边距一起收掉，纸张回到进编辑前的位置
  const paperLeftBefore = document.querySelector('.paper')?.getBoundingClientRect().left ?? null
  if (imagePreviewFrame) cancelAnimationFrame(imagePreviewFrame)
  imagePreviewFrame = 0
  imagePreviewAttrs = null
  for (const frame of document.querySelectorAll('.ProseMirror [data-resize-container].image-editing')) {
    frame.classList.remove('image-editing')
  }
  imagePanel.hidden = true
  imageDim.hidden = true
  workspaceEl.classList.remove('image-edit-mode')
  if (paperLeftBefore != null) {
    const paperLeftAfter = document.querySelector('.paper')?.getBoundingClientRect().left
    if (paperLeftAfter != null) workspaceEl.scrollLeft += paperLeftAfter - paperLeftBefore
  }
  imageDim.removeEventListener('click', onEditorBackdropClick)
  imageDim.removeEventListener('wheel', onImageDimWheel)
  document.removeEventListener('keydown', onImagePanelKeydown, true)
  editor.setEditable(true, false)
  imageEdit = null
  scheduleAutoSave()
  // 图片编辑期间暂停了分页重排（拖拽时重排会打架），收工后补一次
  paginator?.schedule(80)
}

function closeImageEditor () {
  const pos = imageEdit?.pos ?? null
  closeImageEditorUI()
  const node = pos == null ? null : editor.state.doc.nodeAt(pos)
  if (node && node.type.name === 'image') {
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
  }
  editor.view.focus()
}

// 面板里的键盘：Esc = 取消、输入框里 Enter 只确认字段、其他位置 Enter = 完成、
// Ctrl+Enter 永远 = 完成、Tab 只在面板内循环
function onImagePanelKeydown (event) {
  if (!imageEdit) return
  // 有模态框（比如查看大图）开着时键盘归模态框：面板在模态下层是 inert，
  // 这里再把 Tab 抓到面板上会让焦点彻底不动
  if (document.querySelector('dialog[open]')) return
  if (event.isComposing || event.keyCode === 229) return
  // 裁剪状态是 Esc 分层里的最上一层：先退出裁剪，面板留着
  if (event.key === 'Escape' && inCropMode()) {
    event.preventDefault()
    event.stopPropagation()
    cancelCropMode()
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    cancelImageEditing()
    return
  }
  // 裁剪状态下 Enter = 应用裁剪（Ctrl+Enter = 应用并完成，交给下面的分支）
  if (inCropMode()) {
    if (event.key === 'Enter' && !isMod(event) && !isFormTarget(event.target)) {
      event.preventDefault()
      event.stopPropagation()
      applyCropMode()
      return
    }
    if ((event.key === 'c' || event.key === 'C') && !isMod(event) && !isFormTarget(event.target)) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
  }
  // 编辑状态按 C 进裁剪。
  // 面板一打开焦点就落在「宽」的数字框里（openImageEditor 的 rAF 里 focus），
  // 只让 isFormTarget 挡的话这个 C 永远被输入框吃掉，用户看到的就是「按 C 没反应」。
  // 数字框本来也输不进字母，所以只放过数字框，其它输入框/下拉框照旧留给它们自己。
  // 但数字框要是被用户碰过（正在改宽度），就得让它自己用——重复按 C 不能把面板踢进裁剪
  if ((event.key === 'c' || event.key === 'C') && !isMod(event) && !event.altKey &&
      !isTextFormTarget(event.target) && !isUserNumericTarget(event.target)) {
    event.preventDefault()
    event.stopPropagation()
    enterCropMode()
    return
  }
  if (event.key === 'Enter' && isMod(event)) {
    event.preventDefault()
    event.stopPropagation()
    finishImageEditing()
    return
  }
  if (event.key === 'Enter') {
    if (isFormTarget(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    finishImageEditing()
    return
  }
  if (event.key === 'Tab') {
    // 裁剪时焦点在遮罩上的手柄之间循环，手柄也要能 Tab 到
    const root = inCropMode() ? cropOverlay : imagePanel
    const items = [...root.querySelectorAll('button, input, select, [data-handle], [tabindex="0"]')].filter((el) => !el.disabled)
    if (!items.length) return
    // 焦点在面板里而正在裁剪（面板里的按钮仍可点）时，Tab 直接进裁剪框的手柄
    if (inCropMode() && !root.contains(document.activeElement)) {
      event.preventDefault()
      items[0].focus({ preventScroll: true })
      return
    }
    event.preventDefault()
    const index = items.indexOf(document.activeElement)
    const next = event.shiftKey
      ? items[(index <= 0 ? items.length : index) - 1]
      : items[(index + 1) % items.length]
    next.focus({ preventScroll: true })
  }
}

workspaceEl.addEventListener('scroll', () => {
  if (!imageEdit) return
  if (inCropMode()) syncCropOverlay()
  else syncImageDim()
}, { passive: true })
window.addEventListener('resize', () => {
  if (!imageEdit) return
  if (inCropMode()) syncCropOverlay()
  else syncImageDim()
})

// 选中图片后按 Enter 也进编辑（和双击、右键菜单同一个入口）
document.addEventListener('keydown', (event) => {
  if (imageEdit || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  if (event.key !== 'Enter' || isMod(event) || event.altKey || event.shiftKey) return
  if (isFormTarget(event.target)) return
  if (editor.state.selection.node?.type.name !== 'image') return
  event.preventDefault()
  event.stopPropagation()
  openImageEditor()
}, true)

// 选中整张图片后按 C 直接进裁剪。没有这道守卫时这就是普通输入——
// 选区整个是一张图片节点，敲一个 c 会把它替换成一个字母。
document.addEventListener('keydown', (event) => {
  if (imageEdit || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  if (event.key !== 'c' && event.key !== 'C') return
  if (isMod(event) || event.altKey || event.shiftKey) return
  if (isFormTarget(event.target) || document.querySelector('dialog[open]')) return
  if (editor.state.selection.node?.type.name !== 'image') return
  event.preventDefault()
  event.stopPropagation()
  openImageEditor(editor.state.selection.from)
  enterCropMode()
}, true)

// 选中图片后按空格查看大图（和资源管理器习惯一致）。空格在正文里只用来输入空格，
// 所以要和「选区是整张图片」严格绑定；输入框、组合态、对话框里都不拦
document.addEventListener('keydown', (event) => {
  if (imageEdit || imageViewer.open || event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  if (event.key !== ' ' && event.key !== 'Spacebar') return
  if (isMod(event) || event.altKey || event.shiftKey) return
  if (isFormTarget(event.target) || document.querySelector('dialog[open]')) return
  if (editor.state.selection.node?.type.name !== 'image') return
  event.preventDefault()
  event.stopPropagation()
  openImageViewer()
}, true)

// 双击图片进入编辑；输入法组合中不进入
editor.view.dom.addEventListener('dblclick', (event) => {
  // 组合态在 mousedown 那一刻就记下了：PM 的 mousedown 会先 endComposition。
  // 第二次按下时组合已经结束，所以要沿用第一下留下的时间戳
  const composingRecently = Date.now() - composingPressAt < 700
  if (imageEdit || composingAtPress || composingRecently || editor.view.composing || event.isComposing) return
  const image = event.target.closest('img')
  if (!image) return
  const pos = editor.view.posAtDOM(image, 0)
  editor.chain().focus().setNodeSelection(pos).run()
  openImageEditor(pos)
})

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => document.querySelector(`#${button.dataset.closeDialog}`)?.close())
})

/* ---------------- 图片查看器（V6） ---------------- */

// 只看不改：缩放和平移全部落在 CSS transform 上，不发 ProseMirror 事务，
// 所以 dirty、撤销栈、选区都和打开前一样。显示的是节点里的 src（完整原图，不带裁剪）。
const imageViewer = document.querySelector('#imageViewer')
const viewerStage = document.querySelector('#viewerStage')
const viewerImage = document.querySelector('#viewerImage')
const viewerPercent = document.querySelector('#viewerPercent')
const VIEWER_MIN = 0.1
const VIEWER_MAX = 8
const VIEWER_STEP = 1.2

let viewerState = null
let viewerDrag = null
let viewerRestore = null

function viewerNaturalSize () {
  return {
    width: viewerImage.naturalWidth || 1,
    height: viewerImage.naturalHeight || 1
  }
}

// 适合窗口：按舞台可用区域（去掉工具条）取能放下的比例，且不超过 100%
function viewerFitScale () {
  const { width, height } = viewerNaturalSize()
  const stage = viewerStage.getBoundingClientRect()
  return Math.min(1, stage.width / width, stage.height / height)
}

function applyViewerTransform () {
  if (!viewerState) return
  const { zoom, x, y } = viewerState
  viewerImage.style.transform = `translate(${x}px, ${y}px) scale(${zoom})`
  viewerPercent.textContent = `${Math.round(zoom * 100)}%`
}

// 缩放：默认为舞台中心，滚轮缩放时按指针位置锚定（放大前后指针下的像素不动）
function setViewerZoom (next, anchor = null) {
  if (!viewerState) return
  const zoom = clamp(next, VIEWER_MIN, VIEWER_MAX, viewerState.zoom)
  if (zoom === viewerState.zoom) return
  const stage = viewerStage.getBoundingClientRect()
  const ax = anchor ? anchor.x - stage.left : stage.width / 2
  const ay = anchor ? anchor.y - stage.top : stage.height / 2
  const centerX = stage.width / 2
  const centerY = stage.height / 2
  const ratio = zoom / viewerState.zoom
  viewerState.x = ax - centerX - (ax - centerX - viewerState.x) * ratio
  viewerState.y = ay - centerY - (ay - centerY - viewerState.y) * ratio
  viewerState.zoom = zoom
  applyViewerTransform()
}

function fitViewer () {
  if (!viewerState) return
  viewerState.zoom = viewerFitScale()
  viewerState.x = 0
  viewerState.y = 0
  applyViewerTransform()
}

function actualSizeViewer () {
  setViewerZoom(1)
  if (!viewerState) return
  viewerState.x = 0
  viewerState.y = 0
  applyViewerTransform()
}

function panViewer (dx, dy) {
  if (!viewerState) return
  viewerState.x += dx
  viewerState.y += dy
  applyViewerTransform()
}

function openImageViewer (pos = null) {
  const selection = editor.state.selection
  const target = pos == null ? (selection.node?.type.name === 'image' ? selection.from : null) : pos
  const node = target == null ? null : editor.state.doc.nodeAt(target)
  if (!node || node.type.name !== 'image' || !node.attrs.src) {
    showStatus('请先在文档中单击选中图片')
    return
  }
  // 记下打开前的焦点和选区，关闭时原样还回去
  viewerRestore = {
    selection: editor.state.selection,
    editableFocus: editor.view.hasFocus(),
    activeElement: document.activeElement
  }
  viewerImage.src = node.attrs.src
  // 先 showModal 再量舞台：display:none 时 getBoundingClientRect 全是 0
  if (!imageViewer.open) imageViewer.showModal()
  const show = () => {
    if (!viewerState) return
    viewerState.zoom = viewerFitScale()
    viewerState.x = 0
    viewerState.y = 0
    applyViewerTransform()
  }
  viewerState = { zoom: 1, x: 0, y: 0, source: node.attrs.src }
  if (viewerImage.complete && viewerImage.naturalWidth) show()
  else viewerImage.addEventListener('load', show, { once: true })
  document.querySelector('#btnViewerZoomIn').focus({ preventScroll: true })
}

function closeImageViewer () {
  if (!imageViewer.open) return
  imageViewer.close()
}

// close 事件统一收尾：恢复焦点和选区，把状态清干净（打开失败也不会留下残余）
imageViewer.addEventListener('close', () => {
  const restore = viewerRestore
  viewerRestore = null
  viewerState = null
  viewerDrag = null
  viewerImage.removeAttribute('src')
  viewerImage.style.transform = ''
  viewerImage.style.cursor = 'grab'
  viewerStage.classList.remove('grabbing')
  // 回到正文：图片保持选中（打开前的选区原样写回，不进历史）
  if (restore && editor.isEditable) {
    const selection = editor.state.selection
    if (!selection.eq(restore.selection)) {
      editor.view.dispatch(editor.state.tr.setSelection(restore.selection))
    }
    if (restore.editableFocus) editor.view.focus()
    else if (restore.activeElement?.focus && document.contains(restore.activeElement)) restore.activeElement.focus({ preventScroll: true })
  }
})

document.querySelector('#btnViewerClose').addEventListener('click', closeImageViewer)
document.querySelector('#btnViewerZoomIn').addEventListener('click', () => setViewerZoom(viewerState.zoom * VIEWER_STEP))
document.querySelector('#btnViewerZoomOut').addEventListener('click', () => setViewerZoom(viewerState.zoom / VIEWER_STEP))
document.querySelector('#btnViewerFit').addEventListener('click', fitViewer)
document.querySelector('#btnViewerActual').addEventListener('click', actualSizeViewer)

// 滚轮：普通滚轮和 Ctrl+滚轮（触控板捏合在 WebView2 里也变成 Ctrl+滚轮）都缩放，
// 一律 preventDefault —— 查看器里不能让页面或文档跟着滚
viewerStage.addEventListener('wheel', (event) => {
  if (!viewerState) return
  event.preventDefault()
  const factor = event.deltaY < 0 ? VIEWER_STEP : 1 / VIEWER_STEP
  setViewerZoom(viewerState.zoom * factor, { x: event.clientX, y: event.clientY })
}, { passive: false })

// 拖动平移：只有在图片被缩放后才有意义，但任何缩放都允许拖
viewerStage.addEventListener('pointerdown', (event) => {
  if (!viewerState || event.button !== 0) return
  event.preventDefault()
  viewerDrag = { id: event.pointerId, lastX: event.clientX, lastY: event.clientY }
  viewerStage.setPointerCapture(event.pointerId)
  viewerImage.style.cursor = 'grabbing'
  viewerStage.classList.add('grabbing')
})
viewerStage.addEventListener('pointermove', (event) => {
  if (!viewerDrag || event.pointerId !== viewerDrag.id) return
  panViewer(event.clientX - viewerDrag.lastX, event.clientY - viewerDrag.lastY)
  viewerDrag.lastX = event.clientX
  viewerDrag.lastY = event.clientY
})
function endViewerDrag (event) {
  if (!viewerDrag || (event && event.pointerId !== viewerDrag.id)) return
  try {
    viewerStage.releasePointerCapture(viewerDrag.id)
  } catch {}
  viewerDrag = null
  viewerImage.style.cursor = 'grab'
  viewerStage.classList.remove('grabbing')
}
viewerStage.addEventListener('pointerup', endViewerDrag)
viewerStage.addEventListener('pointercancel', endViewerDrag)

// 双击：适合窗口 ⇄ 100%，指针位置仍作锚点
viewerStage.addEventListener('dblclick', (event) => {
  if (!viewerState) return
  event.preventDefault()
  const atFit = Math.abs(viewerState.zoom - viewerFitScale()) < 0.001
  if (atFit) setViewerZoom(1, { x: event.clientX, y: event.clientY })
  else fitViewer()
})

// 键盘：+ / - 缩放，0 适合窗口，1 原始大小，方向键平移，Esc 由 <dialog> 自己关
imageViewer.addEventListener('keydown', (event) => {
  if (!viewerState || event.defaultPrevented) return
  if (isMod(event) || event.altKey) return
  const key = event.key
  // Tab 只在工具条按钮之间循环：modal 底下的面板是 inert，跑到 BODY 上焦点就丢了
  if (key === 'Tab') {
    const items = [...imageViewer.querySelectorAll('button, [tabindex="0"]')].filter((el) => !el.disabled)
    if (!items.length) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement)
    const next = event.shiftKey
      ? items[(index <= 0 ? items.length : index) - 1]
      : items[(index + 1) % items.length]
    next.focus({ preventScroll: true })
    return
  }
  if (key === '+' || key === '=' || key === 'Add') {
    event.preventDefault()
    setViewerZoom(viewerState.zoom * VIEWER_STEP)
    return
  }
  if (key === '-' || key === 'Subtract') {
    event.preventDefault()
    setViewerZoom(viewerState.zoom / VIEWER_STEP)
    return
  }
  if (key === '0') {
    event.preventDefault()
    fitViewer()
    return
  }
  if (key === '1') {
    event.preventDefault()
    actualSizeViewer()
    return
  }
  const panStep = event.shiftKey ? 80 : 40
  if (key === 'ArrowLeft' || key === 'ArrowUp' || key === 'ArrowRight' || key === 'ArrowDown') {
    event.preventDefault()
    panViewer(
      key === 'ArrowLeft' ? -panStep : key === 'ArrowRight' ? panStep : 0,
      key === 'ArrowUp' ? -panStep : key === 'ArrowDown' ? panStep : 0
    )
  }
})

// 查看器是从图片编辑面板里打开的，所以 Esc 只能关查看器这一层：
// 捕获阶段先关掉，并用 stopImmediatePropagation 挡住同一个 document 上后注册的
// 编辑面板监听（否则它会把「取消图片编辑」也一起做了）
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || !imageViewer.open) return
  event.preventDefault()
  event.stopImmediatePropagation()
  closeImageViewer()
}, true)

document.querySelector('#btnPanelViewImage').addEventListener('click', () => {
  if (!imageEdit) return
  openImageViewer(imageEdit.pos)
})

// 给自测脚本用的小接口（不对外）
window.__wlImageViewer = {
  isOpen: () => imageViewer.open,
  open: (pos) => openImageViewer(pos),
  close: () => closeImageViewer(),
  state: () => viewerState ? { ...viewerState } : null,
  fitScale: () => viewerFitScale(),
  zoom: (value) => setViewerZoom(value),
  fit: () => fitViewer(),
  actual: () => actualSizeViewer(),
  pan: (dx, dy) => panViewer(dx, dy),
  stage: () => viewerStage,
  image: () => viewerImage
}

/* ---------------- 右键菜单 ---------------- */

const contextMenu = document.querySelector('#contextMenu')
const contextMenuList = contextMenu.querySelector('.context-menu-list')
const modifierLabel = isMac ? '⌘' : 'Ctrl'

let contextMenuInfo = null
// 右键按下前的选区：ProseMirror 收到右键鼠标事件时可能把整格选中收成光标，
// 这里先记一份，右键落在原选区里就用它还原（R-04 表格整格复制）
let contextMenuAnchor = null

function isContextMenuOpen () {
  return !contextMenu.hidden
}

// 菜单项按位置和状态现拼：复制都用 ProseMirror 自己的序列化，格式和 Ctrl+C 一致
function contextMenuItemsFor (kind, state) {
  const canWrite = () => !editor.isReadOnly
  const cutItem = {
    label: '剪切', shortcut: `${modifierLabel}+X`, enabled: canWrite(),
    run: () => { restoreContextMenuSelection(); execEditorCommand('cut') }
  }
  const copyItem = {
    label: '复制', shortcut: `${modifierLabel}+C`, enabled: true,
    run: () => { restoreContextMenuSelection(); execEditorCommand('copy') }
  }
  const pasteItem = {
    // 粘贴：菜单点击本身是用户手势，可以读剪贴板，拿到 text/html 后交给 ProseMirror
    // 的粘贴管线，格式和 Ctrl+V 一致；读不到再退回原生命令，仍不行就提示按快捷键
    label: '粘贴', shortcut: `${modifierLabel}+V`, enabled: canWrite(), run: () => pasteFromClipboard()
  }
  const selectAllItem = {
    label: '全选',
    shortcut: `${modifierLabel}+A`,
    enabled: true,
    run: () => editor.chain().focus().selectAll().run()
  }
  const insertImageItem = {
    label: '插入图片…',
    enabled: canWrite(),
    // 对话框关掉后把焦点还给编辑器，插入位置仍是右键处
    run: () => {
      editor.view.focus()
      insertImage()
    }
  }

  if (kind === 'image') {
    return [
      {
        label: '图片设置…',
        shortcut: 'Enter',
        enabled: true,
        run: () => openImageEditor(imagePosFromSelection())
      },
      {
        label: '查看大图',
        shortcut: 'Space',
        enabled: true,
        // 只看不改：打开前选区已经是这张图（prepareContextMenuSelection 已选中节点）
        run: () => openImageViewer(imagePosFromSelection())
      },
      {
        label: '裁剪',
        enabled: true,
        // 直接进裁剪状态：图片露出完整原图、边框带 8 个手柄
        run: () => {
          if (!imageEdit) openImageEditor(imagePosFromSelection())
          enterCropMode()
        }
      },
      { label: '复制', shortcut: `${modifierLabel}+C`, enabled: true,
        run: () => { restoreContextMenuSelection(); execEditorCommand('copy') } },
      {
        label: '删除',
        enabled: canWrite(),
        run: () => editor.chain().focus().deleteSelection().run()
      }
    ]
  }

  if (kind === 'table') {
    const can = (command) => editor.can().chain().focus()[command]().run()
    return [
      cutItem,
      copyItem,
      pasteItem,
      { separator: true },
      { label: '在上方插入行', enabled: can('addRowBefore'), run: () => editor.chain().focus().addRowBefore().run() },
      { label: '在下方插入行', enabled: can('addRowAfter'), run: () => editor.chain().focus().addRowAfter().run() },
      { label: '在左侧插入列', enabled: can('addColumnBefore'), run: () => editor.chain().focus().addColumnBefore().run() },
      { label: '在右侧插入列', enabled: can('addColumnAfter'), run: () => editor.chain().focus().addColumnAfter().run() },
      { label: '删除行', enabled: can('deleteRow'), run: () => editor.chain().focus().deleteRow().run() },
      { label: '删除列', enabled: can('deleteColumn'), run: () => editor.chain().focus().deleteColumn().run() },
      { label: '合并单元格', enabled: can('mergeCells'), run: () => editor.chain().focus().mergeCells().run() },
      { label: '拆分单元格', enabled: can('splitCell'), run: () => editor.chain().focus().splitCell().run() },
      { separator: true },
      insertImageItem
    ]
  }

  // 正文文字和纸空白处：没有选区时不给「剪切」，和 Word 里灰掉的效果一致
  const items = !state.selection.empty
    ? [cutItem, copyItem]
    : [copyItem]
  return [...items, pasteItem, selectAllItem, { separator: true }, insertImageItem]
}

// 剪切 / 复制走 Chromium 原生命令：ProseMirror 的剪贴板序列化会在 keydown 时
// 挂好，结果和 Ctrl+X / Ctrl+C 完全一样（选中的图片按节点复制）。
function execEditorCommand (command) {
  editor.view.focus()
  return document.execCommand(command)
}

function buildContextMenu (items) {
  // 先显示再拼项：隐藏状态（display:none）里的按钮拿不到焦点
  contextMenu.hidden = false
  contextMenuList.innerHTML = ''
  for (const item of items) {
    if (item.separator) {
      const line = document.createElement('div')
      line.className = 'context-menu-separator'
      contextMenuList.appendChild(line)
      continue
    }
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'context-menu-item'
    button.setAttribute('role', 'menuitem')
    if (item.enabled === false) {
      button.disabled = true
      button.setAttribute('aria-disabled', 'true')
    }
    const label = document.createElement('span')
    label.textContent = item.label
    button.appendChild(label)
    if (item.shortcut) {
      const key = document.createElement('span')
      key.className = 'context-menu-shortcut'
      key.textContent = item.shortcut
      button.appendChild(key)
    }
    button.addEventListener('click', () => {
      if (item.enabled === false) return
      closeContextMenu(false)
      item.run()
    })
    contextMenuList.appendChild(button)
  }
  const enabled = contextMenuList.querySelectorAll('.context-menu-item:not(:disabled)')
  if (enabled[0]) enabled[0].focus({ preventScroll: true })
}

// 贴着指针（或光标）显示；靠右/靠下放不下时翻到另一侧，保证整块菜单在窗口里
function placeContextMenu (x, y) {
  contextMenu.hidden = false
  contextMenu.style.left = '0px'
  contextMenu.style.top = '0px'
  const box = contextMenu.getBoundingClientRect()
  const gap = 8
  let left = x
  let top = y
  if (left + box.width + gap > window.innerWidth) left = Math.max(gap, x - box.width)
  if (top + box.height + gap > window.innerHeight) top = Math.max(gap, y - box.height)
  contextMenu.style.left = `${Math.round(left)}px`
  contextMenu.style.top = `${Math.round(top)}px`
}

// 菜单打开后 ProseMirror 可能又把选区收成光标（右键的 mouseup 在菜单弹出之后），
// 执行剪切 / 复制前按 mousedown 记下的选区还原一次
function restoreContextMenuSelection () {
  if (!contextMenuAnchor) return
  if (!editor.state.selection.empty) return
  editor.view.dispatch(editor.state.tr.setSelection(contextMenuAnchor.selection))
}

function openContextMenuAt (x, y, kind) {
  const items = contextMenuItemsFor(kind, editor.state)
  contextMenuInfo = { kind, x, y }
  buildContextMenu(items)
  placeContextMenu(x, y)
}

function closeContextMenu (returnFocus = false) {
  if (contextMenu.hidden && !contextMenuInfo) return
  contextMenu.hidden = true
  contextMenuInfo = null
  if (returnFocus) editor.view.focus()
}

// 从 DOM 判断右键落在哪：图片、表格单元格、正文文字、纸边距/灰底，以及功能区和对话框这类不弹菜单的地方
function contextMenuTarget (event) {
  const target = event.target
  if (!target || !target.closest) return null
  if (target.closest('#ribbon, #statusbar, dialog, #contextMenu, .find-bar')) return null
  const workspace = target.closest('#workspace')
  if (!workspace) return null
  if (target.closest('img')) return { kind: 'image' }
  if (target.closest('td, th')) return { kind: 'table' }
  if (target.closest('.ProseMirror')) return { kind: 'text' }
  return { kind: 'blank' }
}

// 右键时的选区规则（和 Word 一致）：点在选区里保留选区，点在选区外把光标移过去；
// 图片先选中节点；输入法组合中什么都不做
function prepareContextMenuSelection (kind, event, hit) {
  if (editor.view.composing) return false
  const state = editor.state
  const pos = hit ? hit.pos : null

  if (kind === 'image') {
    const img = event.target.closest('img')
    let imagePos = pos
    try {
      imagePos = editor.view.posAtDOM(img, 0)
    } catch {
      // 用 posAtCoords 的结果兜底
    }
    if (imagePos == null || imagePos < 0) return false
    const node = state.doc.nodeAt(imagePos)
    if (!node || node.type.name !== 'image') return false
    if (state.selection.from !== imagePos || state.selection.to !== imagePos + node.nodeSize) {
      editor.view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, imagePos)))
    }
    return true
  }

  if (kind === 'text' || kind === 'table') {
    if (pos == null) return false
    const selection = state.selection
    // ProseMirror 收到右键时可能把整格选中收成光标：先按 mousedown 记下的选区还原
    if (contextMenuAnchor && selection.empty) {
      const anchor = contextMenuAnchor.selection
      const inCell = contextMenuAnchor.cells.some((cell) => cell.from <= pos && pos <= cell.to)
      if (inCell || anchor.from <= pos && pos <= anchor.to) {
        editor.view.dispatch(state.tr.setSelection(anchor))
        return true
      }
    }
    // 在已有选区（包括整格选中）里面右键：选区原样保留
    if (!selection.empty && selection.from <= pos && pos <= selection.to) return true
    // 点在选区外面：光标移到点击处（Word 的行为），选区随之消失、从零开始拖选
    const next = TextSelection.create(state.doc, pos)
    if (!selection.eq(next)) editor.view.dispatch(state.tr.setSelection(next))
    return true
  }

  // 纸边距、灰底：按 X1 的规则落到最近的文字位置
  if (kind === 'blank') {
    const target = blankPos(event.clientX, event.clientY)
    const selection = TextSelection.near(state.doc.resolve(target), -1)
    if (!selection.eq(state.selection)) editor.view.dispatch(state.tr.setSelection(selection))
    return true
  }
  return true
}

document.addEventListener('contextmenu', (event) => {
  // 输入框保留默认菜单：查找框、对话框里的数字输入都要能复制粘贴
  if (isFormTarget(event.target)) return
  event.preventDefault()
  // 组合输入中点右键：菜单不弹、选区不动，拼音留在输入法里
  // 不能只看 editor.view.composing —— PM 的 mousedown 可能已经把组合结束了
  if (editor.view.composing || Date.now() - composingRightPressAt < 700 || event.isComposing) {
    closeContextMenu(false)
    return
  }
  const spot = contextMenuTarget(event)
  if (!spot) {
    closeContextMenu(false)
    return
  }
  const hit = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (!prepareContextMenuSelection(spot.kind, event, hit)) {
    closeContextMenu(false)
    return
  }
  openContextMenuAt(event.clientX, event.clientY, spot.kind)
}, true)

// Shift+F10 / 菜单键：在光标处弹出，键盘直接操作
function openContextMenuFromKeyboard () {
  if (editor.view.composing) return
  if (document.querySelector('dialog[open]')) return
  const state = editor.state
  const selection = state.selection
  let kind = 'text'
  if (selection.node?.type.name === 'image') kind = 'image'
  else if (state.selection.$from.parent.type.name === 'tableCell' ||
    state.selection.$from.parent.type.name === 'tableHeader' ||
    state.selection.$from.node(-1)?.type.name === 'table') kind = 'table'
  let x
  let y
  try {
    const coords = editor.view.coordsAtPos(selection.from)
    x = coords.left
    y = coords.bottom
  } catch {
    x = window.innerWidth / 2
    y = window.innerHeight / 2
  }
  openContextMenuAt(x, y, kind)
}

contextMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    // Tab 在菜单里循环，不跑出去
    event.preventDefault()
    const items = [...contextMenuList.querySelectorAll('.context-menu-item:not(:disabled)')]
    if (!items.length) return
    const index = items.indexOf(document.activeElement)
    const next = event.shiftKey
      ? items[(index <= 0 ? items.length : index) - 1]
      : items[(index + 1) % items.length]
    next.focus({ preventScroll: true })
    return
  }
  // Enter 直接执行当前高亮项，不依赖浏览器给按钮合成的 click
  if (event.key === 'Enter') {
    event.preventDefault()
    const item = document.activeElement
    if (item && item.classList?.contains('context-menu-item') && !item.disabled) item.click()
    return
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const items = [...contextMenuList.querySelectorAll('.context-menu-item:not(:disabled)')]
    if (!items.length) return
    const index = items.indexOf(document.activeElement)
    const step = event.key === 'ArrowDown' ? 1 : -1
    const next = items[(index + step + items.length) % items.length]
    next.focus({ preventScroll: true })
  }
})

// 右键按下前先记下选区：ProseMirror 处理右键时可能把整格选中收成光标。
// 整格选中额外记下每个选中的单元格在文档里的范围（CellSelection 的 from/to 只覆盖
// 一个角，而且选区一变表格 DOM 会重建，不能按节点身份认）
document.addEventListener('mousedown', (event) => {
  if (event.button !== 2) return
  const state = editor.state
  const selection = state.selection
  if (selection.empty) {
    contextMenuAnchor = null
    return
  }
  const cells = []
  for (const cell of editor.view.dom.querySelectorAll('td.selectedCell, th.selectedCell')) {
    try {
      const from = editor.view.posAtDOM(cell, 0)
      const node = state.doc.nodeAt(from)
      if (node) cells.push({ from, to: from + node.nodeSize })
    } catch {
      // 换算不出来就只按选区范围判断
    }
  }
  contextMenuAnchor = { selection, cells }
}, true)

// 点菜单外面、滚动工作区、窗口失焦都关掉菜单（键盘 Esc 在上面的分层里处理）
document.addEventListener('mousedown', (event) => {
  if (!isContextMenuOpen()) return
  if (event.target.closest?.('#contextMenu')) return
  closeContextMenu(false)
}, true)

workspaceEl.addEventListener('scroll', () => closeContextMenu(false), { passive: true })

window.addEventListener('blur', () => closeContextMenu(false))

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

// 会吃字母的表单控件（数字框只收数字和方向键，按 C 一定没反应，可以不让它当挡箭牌）
function isTextFormTarget (target) {
  const el = target?.closest?.('input, select, textarea')
  if (!el) return false
  return el.tagName === 'SELECT' || el.type === 'text' || el.type === 'search' || el.tagName === 'TEXTAREA'
}

// 数字框只在用户真的碰过它时才算挡箭牌。面板一弹出就自动聚焦「宽」，
// 这时按 C 必须进裁剪；而数字框本身会吞掉字母再漏一笔 input（§4.4「宽度值后面多一个 c」）
const numericInputTouched = new WeakSet()
for (const eventName of ['pointerdown', 'keydown', 'input']) {
  document.addEventListener(eventName, (event) => {
    const el = event.target?.closest?.('input[type="number"]')
    if (el) numericInputTouched.add(el)
  }, true)
}
// Tab 到数字框：焦点变化本身就是用户意图。面板弹开那一瞬间的自动聚焦不算
let panelFocusArmedAt = 0
document.addEventListener('focusin', (event) => {
  const el = event.target?.closest?.('input[type="number"]')
  if (!el) return
  if (Date.now() - panelFocusArmedAt < 120) return
  numericInputTouched.add(el)
}, true)

function isUserNumericTarget (target) {
  const el = target?.closest?.('input[type="number"]')
  return !!el && numericInputTouched.has(el)
}

/* ---------------- 封堵刷新 ---------------- */

// 页面重载会直接丢掉未保存的内容，刷新和后退对写字板没有任何用处。
// 在捕获阶段只 preventDefault，不 stopPropagation：正文里的 Ctrl+R 还要继续
// 走到下面的「右对齐」分支，查找框、下拉框里的 Ctrl+R 则由那边自己忽略。
const REFRESH_KEY_NAMES = new Set(['BrowserBack', 'BrowserForward', 'BrowserRefresh'])

function isRefreshKey (event) {
  if (REFRESH_KEY_NAMES.has(event.key)) return true
  if (event.key === 'F5') return true
  // Windows 的后退 / 前进是 Alt+← / Alt+→；Mac 上 ⌥← 是「按词移动光标」，不能拦
  if (!isMac && event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return true
  if (!isMod(event) || event.altKey || event.key.toLowerCase() !== 'r') return false
  // 正文里的 Ctrl+R 是「右对齐」：只放过这一个组合，交给下面的快捷键分支；
  // Ctrl+Shift+R 在编辑器里也照样拦，不然 debug 构建里浏览器还会重载
  return event.shiftKey || !editor.view.dom.contains(event.target)
}

document.addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229 || event.defaultPrevented) return
  if (!isRefreshKey(event)) return
  event.preventDefault()
}, true)

// TipTap 自带 Mod-e（行内代码）和 Mod-Enter（换行），与 Word 的居中/分页冲突，
// 在捕获阶段先截住，避免编辑器快捷键抢先处理。
document.addEventListener('keydown', (e) => {
  if (!isMod(e) || e.altKey || e.isComposing || e.defaultPrevented || isFormTarget(e.target)) return
  // 图片编辑期间 Ctrl+Enter 是「完成」，分页符让给面板（面板自己也会拦一次，这里兜底）
  if (e.code === 'Enter' && imageEdit) return
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
  if (e.key === 'Escape' && !e.isComposing && e.keyCode !== 229) {
    // 有模态对话框时交给对话框自己处理，Esc 只关最上层
    // 图片面板是 Esc 分层的最上面一层（V5b 会再插一层「裁剪」），比菜单和查找栏都早，
    // 而且只退一层，不能顺手把查找栏一起关掉
    if (imageEdit && !document.querySelector('dialog[open]')) {
      e.preventDefault()
      cancelImageEditing()
      return
    }
    if (!document.querySelector('dialog[open]')) {
      // 右键菜单比查找栏更靠上：先关菜单，查找栏留到下一次 Esc
      if (isContextMenuOpen()) {
        e.preventDefault()
        closeContextMenu(true)
        return
      }
      if (!findBar.hidden) {
        e.preventDefault()
        closeFind()
        return
      }
      closePopovers()
    }
  }
  // Shift+F10 / 菜单键：在当前光标处弹出右键菜单
  if ((e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) && !e.isComposing && e.keyCode !== 229) {
    if (document.querySelector('dialog[open]')) return
    e.preventDefault()
    openContextMenuFromKeyboard()
    return
  }
  if (e.isComposing || e.defaultPrevented) return

  if (e.key === 'F1') {
    e.preventDefault()
    openHelp()
    return
  }

  // Mac：⌘? 打开帮助（F1 仍然有效）
  if (isMac && e.metaKey && !e.ctrlKey && !e.altKey && e.key === '?') {
    e.preventDefault()
    openHelp()
    return
  }

  // Mac：替换改用 ⌥⌘F（⌘H 是系统「隐藏」）。按住 Option 时 e.key 变成 ƒ，
  // 只能用 e.code 判断，所以这条必须放在下面 altKey 早退之前
  if (isMac && e.metaKey && e.altKey && !e.ctrlKey && e.code === 'KeyF') {
    e.preventDefault()
    openFind('replace')
    return
  }

  if (!isMod(e) || e.altKey) return
  const key = e.key.toLowerCase()
  const inForm = isFormTarget(e.target)

  if (key === 's') {
    e.preventDefault()
    saveDocument(e.shiftKey)
    return
  }
  // 查找/替换优先于普通表单输入，但设置、帮助等模态框打开时不抢快捷键
  // Mac 上 ⌘H 留给系统「隐藏」，替换改走上面的 ⌥⌘F
  if (!e.shiftKey && (key === 'f' || (!isMac && key === 'h')) && !document.querySelector('dialog[open]')) {
    e.preventDefault()
    openFind(key === 'h' ? 'replace' : 'find')
    return
  }
  // 打印不受表单焦点影响：从「页码」下拉框选完直接按 Ctrl+P 也要能打印。
  // directPrint 自己会在有模态对话框时退出，所以对话框里不会误触。
  if (key === 'p') {
    e.preventDefault()
    directPrint()
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
    newDocumentOrWindow()
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
  // 页面缩放：Ctrl+Shift+= / Ctrl+Shift+-。必须排在下面的上下标分支之前——
  // 那条 e.code === 'Equal' 不带 shiftKey 判断，会连 Ctrl+Shift+= 一起吃掉
  if (e.shiftKey && e.code === 'Equal') {
    e.preventDefault()
    stepPageZoom(1)
    return
  }
  if (e.shiftKey && e.code === 'Minus') {
    e.preventDefault()
    stepPageZoom(-1)
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
  // 页面缩放用 Ctrl+Shift+= / Ctrl+Shift+-：Ctrl+= 和 Ctrl+Shift+= 在这个
  // 软件里已经是下标/上标（Word 的约定），Ctrl+0 是「正文」，不能抢。
  // e.code 判断是因为按住 Shift 时 e.key 会变成 '+' / '_'
  if (e.shiftKey && e.code === 'Equal') {
    e.preventDefault()
    stepPageZoom(1)
    return
  }
  if (e.shiftKey && e.code === 'Minus') {
    e.preventDefault()
    stepPageZoom(-1)
    return
  }
  // Mac 上 ⌘M 是系统「最小化」，缩进改用 ⌘] / ⌘[（由 Indent 扩展自带的 Mod-] / Mod-[ 处理）
  if (key === 'm' && !isMac) {
    e.preventDefault()
    if (e.shiftKey) editor.chain().focus().outdent().run()
    else editor.chain().focus().indent().run()
  }
})

/* ---------------- Mac 快捷键文案 ---------------- */

// D4：Mac 上 Ctrl 一律换成 ⌘，另有三处和系统冲突的键位要改
function localizeShortcutText (text) {
  if (!isMac || !text) return text
  return text
    .replace(/Ctrl\+Shift\+M\b/g, '⌘[')
    .replace(/Ctrl\+M\b/g, '⌘]')
    .replace(/Ctrl\+H\b/g, '⌥⌘F')
    .replace(/Ctrl\+/g, '⌘')
    .replace(/Shift\+/g, '⇧')
    .replace(/Alt\+/g, '⌥')
    .replace(/\bF1\b/g, '⌘?')
}

// 启动时把界面里写死的快捷键文案换成 Mac 记法；Windows 上什么也不做
function localizeShortcuts () {
  if (!isMac) return
  for (const el of document.querySelectorAll('[title]')) {
    // 最近文件的标题是磁盘路径，可能含 “Ctrl+” 这类文件名，不能改
    if (el.closest('#recentList')) continue
    const before = el.title
    const after = localizeShortcutText(before)
    if (after === before) continue
    el.title = after
    if (el.getAttribute('aria-label') === before) el.setAttribute('aria-label', after)
  }
  for (const el of document.querySelectorAll('kbd')) {
    el.textContent = localizeShortcutText(el.textContent)
  }
  // 帮助正文里的快捷键说明（例如“Ctrl+F 查找、F1 打开帮助”）
  const helpDialog = document.querySelector('#helpDialog')
  if (helpDialog) {
    const walker = document.createTreeWalker(helpDialog, NodeFilter.SHOW_TEXT)
    const nodes = []
    while (walker.nextNode()) nodes.push(walker.currentNode)
    for (const node of nodes) node.nodeValue = localizeShortcutText(node.nodeValue)
    // 关于里的技术栈也跟着平台走
    for (const span of helpDialog.querySelectorAll('.help-about-meta span')) {
      if (span.textContent.includes('WebView2')) span.textContent = span.textContent.replace('WebView2', 'WKWebView')
    }
  }
  // Mac 的 ⌘N 是新建窗口，不是清空当前窗口：按钮提示和帮助表都按 Mac 惯例写
  const newButton = document.querySelector('#btnNew')
  if (newButton) newButton.title = '新建窗口 (⌘N)'
  for (const label of document.querySelectorAll('.shortcut-grid > span')) {
    const kbd = label.nextElementSibling
    if (kbd && kbd.tagName === 'KBD' && kbd.textContent === '⌘N') label.textContent = '新建窗口'
  }
}

/* ---------------- 工具栏状态同步 ---------------- */

function syncToolbar () {
  const setActive = (cmd, active) => {
    document.querySelectorAll(`[data-cmd="${cmd}"]`).forEach((el) => {
      el.classList.toggle('active', !!active)
      el.setAttribute('aria-pressed', String(!!active))
    })
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
  const lineHeightValue = block.lineHeight == null ? '' : String(block.lineHeight)
  const exactLine = /^([\d.]+)pt$/i.exec(lineHeightValue)
  syncDynamicOption(
    document.querySelector('#lineHeight'),
    lineHeightValue,
    exactLine ? `固定值 ${Number(exactLine[1])} 磅` : `${lineHeightValue} 倍`
  )
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

  syncDetailControls()
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

function cssQuoted (text) {
  return `"${String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ')}"`
}

// 打印页的页眉/页脚/页码写在 @page 的页边距盒子里；屏幕页层用同样的内容画。
// 六个盒子都显式声明，WebView2 才不会再加自己的日期/标题/网址页眉页脚。
function buildPrintPageStyle (dimensions, margins) {
  const align = pageSetup.headerFooterAlign
  const position = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center'
  const header = pageSetup.headerText.trim()
  const footer = pageSetup.footerText.trim()
  const printNumber = pageSetup.pageNumber === 'print'
  const fontSize = pageSetup.headerFooterFontSize
  const numberFontSize = Math.max(6, Math.round((fontSize - 1) * 2) / 2)
  // 页码和页脚文字分开放：有页脚时页码去对面（页脚居中则页码靠右），
  // 没有页脚时页码按页脚对齐方式放。这样两行内容不会挤在同一个边距盒里。
  const numberPosition = footer
    ? (position === 'right' ? 'left' : 'right')
    : position
  const base = `font-size:${fontSize}pt;color:#595959;font-family:"等线","Microsoft YaHei","PingFang SC",sans-serif;`
  const numberBase = `font-size:${numberFontSize}pt;color:#8a8f99;` +
    'font-family:"等线","Microsoft YaHei","PingFang SC",sans-serif;' +
    'letter-spacing:0.04em;font-variant-numeric:tabular-nums;'
  const boxes = []
  for (const side of ['top', 'bottom']) {
    for (const pos of ['left', 'center', 'right']) {
      const name = `${side}-${pos}`
      let content = '""'
      let style = base
      if (side === 'top' && pos === position && header) {
        content = cssQuoted(header)
      }
      if (side === 'bottom') {
        if (footer && pos === position) content = cssQuoted(footer)
        if (printNumber && pos === numberPosition) {
          content = `"— " counter(page) " —"`
          style = numberBase
        }
      }
      boxes.push(`@${name} { content:${content}; ${style} }`)
    }
  }
  return `@page { size: ${dimensions.width}cm ${dimensions.height}cm; ` +
    `margin: ${margins.top}cm ${margins.right}cm ${margins.bottom}cm ${margins.left}cm; ` +
    `${boxes.join(' ')} }`
}

function applyPageSetup () {
  const dimensions = pageDimensions()
  const margins = currentMargins()
  const paper = document.querySelector('.paper')
  paper.style.width = `${dimensions.width}cm`
  paper.style.minHeight = `${dimensions.height}cm`
  paper.style.padding = `${margins.top}cm ${margins.right}cm ${margins.bottom}cm ${margins.left}cm`
  paper.style.setProperty('--paper', pageSetup.background)
  // WKWebView 的打印布局会对 width:100% 自动缩放；用预览同一正文宽度
  // 固定 CSS 像素到纸张的比例，避免字体、行高和段距被一起放大。
  if (isMac) {
    paper.style.setProperty('--print-content-width', `${dimensions.width - margins.left - margins.right}cm`)
  }
  // 打印时页面背景色要铺满整张纸，根元素也同步一份
  document.documentElement.style.setProperty('--paper', pageSetup.background)
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
  // 页眉/页脚/页码写进 @page 页边距盒子；屏幕页层跟着用同样的内容
  document.querySelector('#printPageStyle').textContent = buildPrintPageStyle(dimensions, margins)
  const quickNumber = document.querySelector('#quickPageNumber')
  if (quickNumber) quickNumber.value = pageSetup.pageNumber
  // 纸张尺寸/边距变了，所有页缝位置都要重算
  paginator?.force(0)
}

function setPageSetup (patch) {
  const next = normalizePageSetup({ ...pageSetup, ...patch })
  // 值没变就不动，免得只切“连续阅读”也把文档标成未保存
  if (JSON.stringify(next) === JSON.stringify(pageSetup)) return
  pageSetup = next
  applyPageSetup()
  setDirty(true)
}

/* ---------------- 页面缩放 ---------------- */

// 只缩纸张的显示，不改字号、行高和排版比例，所以打印和导出 PDF 完全不受影响。
// 用 transform 而不是 CSS zoom：zoom 会真的重排，小比例下 WebKit 的行高取整
// 会让文字顶进页缝；transform 是纯显示变换，100% 时排好的分页在任何比例下都成立。
// getBoundingClientRect 跟着缩放，而 clientWidth 仍是排版像素——
// 图片按栏宽算尺寸、点击定位都不用改。
const ZOOM_KEY = 'wordlite.zoom.v1'
const ZOOM_MIN = 10
const ZOOM_MAX = 1000
// 一档一档走，不做连续缩放：触控板一次手势会连发几十个 wheel 事件
const ZOOM_STEPS = [10, 25, 50, 60, 70, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500, 600, 750, 1000]
// 打开固定 100%，不恢复上次比例（上次存的值可能把默认顶成 150% 之类）
let pageZoom = 100
let renderedZoom = 100
// PDF 屏幕捕获期间由捕获流程自己控制 paperScaler 尺寸，ResizeObserver 不要抢
let pdfCaptureActive = false
let lastPointer = null
let pinchAnchor = null

workspaceEl.addEventListener('pointermove', (event) => {
  lastPointer = { x: event.clientX, y: event.clientY }
}, { passive: true })

// 缩放跟随鼠标：鼠标停在页面上时以鼠标为中心；否则以工作区中心
function zoomAnchor () {
  const rect = workspaceEl.getBoundingClientRect()
  if (lastPointer &&
      lastPointer.x >= rect.left && lastPointer.x <= rect.right &&
      lastPointer.y >= rect.top && lastPointer.y <= rect.bottom) {
    return lastPointer
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
}

// 外层的 paperScaler 按“纸张尺寸 × 缩放”撑开，滚动条和居中跟 100% 一致；
// .paper 自己只做 transform，排版尺寸始终不变。
function syncPaperScaler () {
  if (pdfCaptureActive) return
  const paper = document.querySelector('.paper')
  const scaler = document.querySelector('#paperScaler')
  if (!paper || !scaler) return
  const scale = (renderedZoom || 100) / 100
  scaler.style.width = `${(paper.offsetWidth * scale).toFixed(2)}px`
  scaler.style.height = `${(paper.offsetHeight * scale).toFixed(2)}px`
}

const paperScalerObserver = new ResizeObserver(syncPaperScaler)
const zoomPaperEl = document.querySelector('.paper')
if (zoomPaperEl) paperScalerObserver.observe(zoomPaperEl)

function renderPageZoom (value) {
  const paper = document.querySelector('.paper')
  if (!paper) return false
  renderedZoom = value
  const scale = value / 100
  paper.style.transform = value === 100 ? '' : `scale(${scale})`
  document.querySelector('#btnZoomReset').textContent = `${Math.round(value)}%`
  document.querySelector('#btnZoomOut').disabled = value <= ZOOM_MIN
  document.querySelector('#btnZoomIn').disabled = value >= ZOOM_MAX
  syncPaperScaler()
  scheduleSelectionOverlay()
  return true
}

// 以 viewport 上的 anchor 为中心缩放：先记下 anchor 指向的纸面坐标，
// 改完 zoom 后再把滚动条挪回去，让那个点还在鼠标底下。
function renderPageZoomAt (value, anchor) {
  const paper = document.querySelector('.paper')
  if (!paper) return false
  const rect = workspaceEl.getBoundingClientRect()
  const point = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
    ? anchor
    : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  const before = paper.getBoundingClientRect()
  const oldScale = renderedZoom / 100
  const docX = (point.x - before.left) / oldScale
  const docY = (point.y - before.top) / oldScale
  if (!renderPageZoom(value)) return false
  const scale = value / 100
  const after = paper.getBoundingClientRect()
  workspaceEl.scrollLeft += after.left + docX * scale - point.x
  workspaceEl.scrollTop += after.top + docY * scale - point.y
  return true
}

function applyPageZoom (next, anchor) {
  const value = clamp(Math.round(Number(next) || 0), ZOOM_MIN, ZOOM_MAX, pageZoom)
  if (!renderPageZoomAt(value, anchor)) return
  pageZoom = value
  storageWrite(ZOOM_KEY, value)
  requestAnimationFrame(() => {
    if (imageEdit) {
      if (inCropMode()) syncCropOverlay()
      else syncImageDim()
    }
  })
}

function stepPageZoom (direction, anchor) {
  const at = anchor || zoomAnchor()
  if (direction > 0) {
    const next = ZOOM_STEPS.find((step) => step > pageZoom)
    if (next) applyPageZoom(next, at)
  } else if (direction < 0) {
    const prev = ZOOM_STEPS.filter((step) => step < pageZoom).pop()
    if (prev) applyPageZoom(prev, at)
  }
}

// Mac 触控板的双指捏合在 WKWebView 里走 gesturestart / gesturechange / gestureend，
// 不是带修饰键的 wheel（Windows 触控板的捏合才被 WebView2 合成成 Ctrl+滚轮）。
// allowsMagnification 关掉后事件仍然会到网页，正好借它接进页面缩放：
// 手势期间只改显示，松手才写存储，免得一次捏合写几十次 localStorage。
let pinchBaseZoom = null
let pinchPreviewZoom = null
let pinchFrame = 0

function gestureScale (event) {
  const scale = Number(event.scale)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

function queuePinchPreview (value) {
  pinchPreviewZoom = value
  if (pinchFrame) return
  pinchFrame = requestAnimationFrame(() => {
    pinchFrame = 0
    if (pinchPreviewZoom !== null) renderPageZoomAt(pinchPreviewZoom, pinchAnchor)
  })
}

function beginPinchZoom (x, y) {
  if (document.querySelector('dialog[open]')) return false
  if (pinchFrame) {
    cancelAnimationFrame(pinchFrame)
    pinchFrame = 0
  }
  const hasPoint = Number.isFinite(x) && Number.isFinite(y) && (x !== 0 || y !== 0)
  pinchAnchor = hasPoint ? { x, y } : zoomAnchor()
  pinchBaseZoom = pageZoom
  pinchPreviewZoom = null
  renderPageZoom(pageZoom)
  return true
}

function updatePinchZoom (scale) {
  if (pinchBaseZoom === null) return false
  queuePinchPreview(clamp(
    pinchBaseZoom * scale,
    ZOOM_MIN, ZOOM_MAX, pinchBaseZoom
  ))
  return true
}

function endPinchZoom () {
  if (pinchBaseZoom === null) return false
  if (pinchFrame) {
    cancelAnimationFrame(pinchFrame)
    pinchFrame = 0
  }
  const finalZoom = pinchPreviewZoom === null ? pinchBaseZoom : pinchPreviewZoom
  const anchor = pinchAnchor
  pinchBaseZoom = null
  pinchPreviewZoom = null
  pinchAnchor = null
  applyPageZoom(finalZoom, anchor)
  return true
}

window.addEventListener('gesturestart', (event) => {
  if (!beginPinchZoom(event.clientX, event.clientY)) return
  event.preventDefault()
}, { passive: false, capture: true })

window.addEventListener('gesturechange', (event) => {
  if (!updatePinchZoom(gestureScale(event))) return
  event.preventDefault()
}, { passive: false, capture: true })

window.addEventListener('gestureend', (event) => {
  if (!endPinchZoom()) return
  event.preventDefault()
}, { passive: false, capture: true })

// WebView2 的触控板捏合是它自己识别的合成 wheel：ctrlKey=true，但没有物理 Ctrl。
// 真 Ctrl+滚轮一定伴随物理 Ctrl。用这一点分流，捏合走连续缩放。
let physicalCtrlDown = false
window.addEventListener('keydown', (event) => {
  if (event.key === 'Control') physicalCtrlDown = true
}, true)
window.addEventListener('keyup', (event) => {
  if (event.key === 'Control') physicalCtrlDown = false
}, true)
window.addEventListener('blur', () => {
  physicalCtrlDown = false
})

function isPinchWheel (event) {
  return !isMac && event.ctrlKey && !physicalCtrlDown &&
    event.deltaMode === 0 && Math.abs(event.deltaY) < 40
}

// 一连串捏合 delta 当成一次手势：连续预览，180ms 没有新事件就落定。
// 跟手：基础灵敏度比旧版高，再按「单位时间移动量」加一个速度增益——
// 慢捏微调，快捏一次走得多。参数都可调。
const PINCH_BASE = 0.004
// 速度增益只做轻微加速：快捏不再一次冲很远，减少“跟不上手”的感觉
const PINCH_SPEED_GAIN = 1.8
const PINCH_GAIN_MAX = 2.2
let wheelZoomTimer = 0
let wheelZoomTarget = null
let wheelLastAt = 0
let wheelSpeed = 0

window.__wordliteWheelZoom = (delta, x, y) => {
  if (document.querySelector('dialog[open]')) return false
  if (pinchBaseZoom === null) {
    if (!beginPinchZoom(x, y)) return false
    wheelZoomTarget = pageZoom
    wheelLastAt = 0
    wheelSpeed = 0
  }
  const now = performance.now()
  const dt = wheelLastAt ? Math.max(8, now - wheelLastAt) : 16
  wheelLastAt = now
  const amount = Math.abs(Number(delta) || 0)
  const instant = amount / dt
  wheelSpeed = wheelSpeed ? wheelSpeed * 0.7 + instant * 0.3 : instant
  const gain = clamp(1 + wheelSpeed * PINCH_SPEED_GAIN, 1, PINCH_GAIN_MAX)
  const factor = Math.pow(1 + PINCH_BASE, (Number(delta) || 0) * gain)
  wheelZoomTarget = clamp(wheelZoomTarget * factor, ZOOM_MIN, ZOOM_MAX, wheelZoomTarget)
  queuePinchPreview(wheelZoomTarget)
  clearTimeout(wheelZoomTimer)
  wheelZoomTimer = setTimeout(() => {
    wheelZoomTimer = 0
    wheelZoomTarget = null
    wheelLastAt = 0
    wheelSpeed = 0
    endPinchZoom()
  }, 180)
  return true
}

// Ctrl+滚轮（Mac 上是 ⌘+滚轮）缩放页面。Mac 的双指捏合走的是系统手势、
// 不是带修饰键的 wheel，所以不会误触——§4.4 那条「捏合不该缩放」仍然成立
function isZoomWheel (event) {
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
}

let lastZoomWheelAt = 0
window.addEventListener('wheel', (event) => {
  if (!isZoomWheel(event) || event.deltaY === 0) return
  // 模态框（设置、帮助、图片查看器）都有自己的滚轮语义，不放给页面缩放；
  // 但也要 preventDefault，别让 WebView2 自己的整页缩放接管
  if (document.querySelector('dialog[open]')) {
    event.preventDefault()
    return
  }
  event.preventDefault()
  // 捏合是 WebView2 合成的连续 wheel；真 Ctrl+滚轮还是按档位走。
  // 合成 delta 的方向和页面缩放相反：捏合（合拢）应该缩小，所以取反。
  if (isPinchWheel(event)) {
    window.__wordliteWheelZoom(-event.deltaY, event.clientX, event.clientY)
    return
  }
  // 触控板惯性会连续发事件：两档之间留 120ms，免得一下滑到底
  const now = Date.now()
  if (now - lastZoomWheelAt < 120) return
  lastZoomWheelAt = now
  stepPageZoom(event.deltaY < 0 ? 1 : -1, { x: event.clientX, y: event.clientY })
}, { passive: false, capture: true })

document.querySelector('#btnZoomIn').addEventListener('click', () => stepPageZoom(1))
document.querySelector('#btnZoomOut').addEventListener('click', () => stepPageZoom(-1))
document.querySelector('#btnZoomReset').addEventListener('click', () => applyPageZoom(100, zoomAnchor()))

/* ---------------- 屏幕分页 ---------------- */

// 页缝宽度按样张定 16px；双击页缝收起空白后变成 0（Word 的“隐藏空白”）
const PAGE_GAP_KEY = 'wordlite.pageGapCollapsed.v1'
let pageGapCollapsed = storageRead(PAGE_GAP_KEY, false) === true

function paginationGeometry () {
  const dimensions = pageDimensions()
  const margins = currentMargins()
  const cm = 96 / 2.54
  return {
    pageWidth: dimensions.width * cm,
    pageHeight: dimensions.height * cm,
    marginTop: margins.top * cm,
    marginRight: margins.right * cm,
    marginBottom: margins.bottom * cm,
    marginLeft: margins.left * cm,
    contentHeight: Math.max(16, (dimensions.height - margins.top - margins.bottom) * cm),
    background: pageSetup.background
  }
}

paginator = createPaginator({
  editor,
  getGeometry: paginationGeometry,
  getGap: () => pageGapCollapsed ? 0 : PAGE_GAP_DEFAULT,
  getScale: () => renderedZoom / 100,
  getReadingMode: () => pageGapCollapsed,
  getPageNumberMode: () => pageSetup.pageNumber,
  getHeaderFooter: () => ({
    header: pageSetup.headerText,
    footer: pageSetup.footerText,
    align: pageSetup.headerFooterAlign,
    fontSize: pageSetup.headerFooterFontSize
  }),
  getLineBreaking: () => pageSetup.lineBreaking !== 'blocks',
  shouldDefer: () => !!imageEdit || imageViewer.open || inCropMode(),
  onPageUpdate: ({ pageCount, readingMode }) => {
    const status = document.querySelector('#pageStatus')
    if (status) status.textContent = readingMode ? `连续阅读 · 共 ${pageCount} 页` : `共 ${pageCount} 页`
    scheduleSelectionOverlay()
  }
})

function setReadingMode (collapsed) {
  if (pageGapCollapsed === collapsed) return
  pageGapCollapsed = collapsed
  storageWrite(PAGE_GAP_KEY, pageGapCollapsed)
  paginator.force(0)
}

function togglePageGap () {
  setReadingMode(!pageGapCollapsed)
}

// 页缝命中测试：用纸面未缩放坐标和分页引擎记下的页缝带比对
function pageGapHit (event) {
  if (document.querySelector('dialog[open]')) return false
  const paper = document.querySelector('.paper')
  if (!paper) return false
  const rect = paper.getBoundingClientRect()
  const scale = renderedZoom / 100 || 1
  if (event.clientX < rect.left || event.clientX > rect.right) return false
  const y = (event.clientY - rect.top) / scale
  return paginator.gapBands().some((band) => y >= band.top - 8 && y <= band.bottom + 8)
}

// 两张纸之间那条窄缝上按下时不要挪光标/开始拖选；纸边距仍然可以拖选
function pageSheetGapHit (event) {
  if (document.querySelector('dialog[open]')) return false
  const sheets = Array.from(document.querySelectorAll('.page-sheet'))
  for (let i = 1; i < sheets.length; i += 1) {
    const above = sheets[i - 1].getBoundingClientRect()
    const below = sheets[i].getBoundingClientRect()
    if (event.clientX >= above.left && event.clientX <= above.right &&
        event.clientY >= above.bottom - 4 && event.clientY <= below.top + 4) {
      return true
    }
  }
  return false
}

workspaceEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  if (!pageSheetGapHit(event) && !(pageGapCollapsed && pageGapHit(event))) return
  event.preventDefault()
  event.stopPropagation()
}, true)

// 双击页缝收起/展开：Word 的隐藏空白。只认落在页缝带里的双击，
// 正文里的双击（选词）原样放过。
workspaceEl.addEventListener('dblclick', (event) => {
  if (!pageGapHit(event)) return
  event.preventDefault()
  event.stopPropagation()
  togglePageGap()
}, true)

// 图片解码完才真正有高度；字体换了行高也会变。这两类变化不一定伴随文档更新
editor.view.dom.addEventListener('load', (event) => {
  if (event.target?.tagName === 'IMG') paginator.force(80)
}, true)
if (document.fonts?.ready) document.fonts.ready.then(() => paginator.force(0))

// 测试和验收用的入口：手动重排、读当前页数/页缝
window.__wordlitePagination = {
  run: () => paginator.runNow(),
  toggleGap: () => togglePageGap(),
  debug: () => paginator.debug(),
  state: () => ({
    pageCount: paginator.getPageCount(),
    gapCount: document.querySelectorAll('.page-gap-widget').length,
    sheetCount: document.querySelectorAll('.page-sheet').length,
    gapBands: paginator.gapBands().length,
    collapsed: pageGapCollapsed
  })
}

/* ---------------- Mac 跨页选区自绘 ----------------
   WKWebView 的原生选区会把跨页间隔 widget 的整块高度涂成蓝色，
   连带盖住页脚、页缝和下一页页眉。跨页时把原生选区设为透明，
   只按文字节点逐行画高亮，页缝和页眉页脚保持干净。 */

const selectionLayer = document.createElement('div')
selectionLayer.className = 'selection-layer'
selectionLayer.setAttribute('aria-hidden', 'true')
const selectionPaper = document.querySelector('.paper')
if (isMac && selectionPaper) selectionPaper.appendChild(selectionLayer)

let selectionOverlayFrame = 0
// 动态挂一条全局 ::selection 规则：Safari 对带后代选择器的 ::selection 支持不稳，
// 真正要隐藏原生高亮时，用最普通、全局的写法最保险
const nativeSelectionHideStyle = document.createElement('style')
nativeSelectionHideStyle.textContent =
  '::selection { background-color: rgba(0, 0, 0, 0) !important; }'
let nativeSelectionHidden = false

function setNativeSelectionHidden (hidden) {
  if (hidden === nativeSelectionHidden) return
  nativeSelectionHidden = hidden
  if (hidden) document.head.appendChild(nativeSelectionHideStyle)
  else nativeSelectionHideStyle.remove()
}

function selectionCrossesGap (range) {
  for (const gap of editor.view.dom.querySelectorAll('.page-gap-widget')) {
    if (range.intersectsNode(gap)) return true
  }
  return false
}

function selectionRectsInPaper (range) {
  const paper = document.querySelector('.paper')
  if (!paper) return []
  const paperRect = paper.getBoundingClientRect()
  const scale = renderedZoom / 100 || 1
  const rects = []
  const push = (rect) => {
    if (!rect || rect.width < 0.5 || rect.height < 0.5) return
    rects.push({
      left: (rect.left - paperRect.left) / scale,
      top: (rect.top - paperRect.top) / scale,
      width: rect.width / scale,
      height: rect.height / scale
    })
  }
  const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue
    // 页缝标记/手动分页符里的说明文字不是正文，不画进选区
    if (node.parentElement?.closest('.page-gap-widget, .page-break')) continue
    if (!range.intersectsNode(node)) continue
    const nodeRange = document.createRange()
    nodeRange.selectNodeContents(node)
    const startCmp = range.compareBoundaryPoints(Range.START_TO_START, nodeRange)
    const endCmp = range.compareBoundaryPoints(Range.END_TO_END, nodeRange)
    let start = 0
    let end = node.nodeValue.length
    if (startCmp > 0) {
      if (range.startContainer === node) start = range.startOffset
      else continue
    }
    if (endCmp < 0) {
      if (range.endContainer === node) end = range.endOffset
      else continue
    }
    if (start >= end) continue
    const piece = document.createRange()
    piece.setStart(node, start)
    piece.setEnd(node, end)
    for (const rect of piece.getClientRects()) push(rect)
  }
  // 图片整块被选中时也给一层高亮（文字的矩形已经覆盖表格里的文字行）
  for (const image of editor.view.dom.querySelectorAll('img')) {
    if (!range.intersectsNode(image)) continue
    push(image.getBoundingClientRect())
  }
  return rects
}

function clearSelectionOverlay () {
  document.body.classList.remove('cross-page-selection')
  setNativeSelectionHidden(false)
  if (selectionLayer.childElementCount) selectionLayer.replaceChildren()
}

function renderSelectionOverlay () {
  if (!isMac) return
  const sel = window.getSelection()
  let range = null
  if (sel && sel.rangeCount && !sel.isCollapsed) {
    const candidate = sel.getRangeAt(0)
    if (editor.view.dom.contains(candidate.commonAncestorContainer) ||
        editor.view.dom.contains(candidate.startContainer)) {
      range = candidate
    }
  }
  if (!range || !(document.hasFocus() || editor.view.hasFocus()) || !selectionCrossesGap(range)) {
    clearSelectionOverlay()
    return
  }
  document.body.classList.add('cross-page-selection')
  setNativeSelectionHidden(true)
  const rects = selectionRectsInPaper(range)
  selectionLayer.replaceChildren(...rects.map((rect) => {
    const div = document.createElement('div')
    div.className = 'selection-rect'
    div.style.left = `${rect.left.toFixed(2)}px`
    div.style.top = `${rect.top.toFixed(2)}px`
    div.style.width = `${rect.width.toFixed(2)}px`
    div.style.height = `${rect.height.toFixed(2)}px`
    return div
  }))
}

function scheduleSelectionOverlay () {
  if (!isMac || selectionOverlayFrame) return
  selectionOverlayFrame = requestAnimationFrame(() => {
    selectionOverlayFrame = 0
    renderSelectionOverlay()
  })
}

if (isMac) {
  document.addEventListener('selectionchange', scheduleSelectionOverlay)
  window.addEventListener('resize', scheduleSelectionOverlay)
  window.addEventListener('blur', clearSelectionOverlay)
  editor.on('blur', clearSelectionOverlay)
  editor.on('focus', scheduleSelectionOverlay)
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
  // HTML title 决定 PDF 元数据里的标题；窗口标题由 Rust 端单独设置
  document.title = `${currentFileName} - 简写`
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
  if (!findBar.hidden) scheduleFindRefresh()
  paginator?.schedule()
}

function setEditorJSON (json) {
  // 换文档前先把图片编辑收掉：面板记的 pos 是旧文档里的位置，留着就是个野指针
  // （Ctrl+O 打开另一个文件后面板还在，按 Esc 会在旧位置 setNodeMarkup 直接抛异常）
  if (imageEdit) closeImageEditorUI()
  // 查看器的 close 事件是异步派发的，会等到 setContent 之后才跑。那时再去写回旧文档的选区
  // 就等于把上一个文档的位置塞进新文档，所以这里先把要还原的选区清掉
  if (imageViewer.open) {
    viewerRestore = null
    closeImageViewer()
  }
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
  paginator?.force(0)
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

const INLINE_NODES = ['text', 'hardBreak', 'image']

function nodeText (node) {
  if (node.type === 'text') return node.text || ''
  if (node.type === 'hardBreak') return '\n'
  if (node.type === 'image') return node.attrs?.alt || ''
  const children = node.content || []
  // 只有全是行内节点时才直接拼接；块级子节点之间换行，避免列表项粘成一串
  const inline = children.every((child) => INLINE_NODES.includes(child.type))
  return children.map(nodeText).join(inline ? '' : '\n')
}

function hasRichFormatting (node) {
  if (!node) return false
  if (node.type === 'heading' || node.type === 'image' || node.type === 'table') return true
  if (node.marks?.length) return true
  return (node.content || []).some(hasRichFormatting)
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

// 导入 DOCX 时行内常常只写了一个 Windows 字体名（例如 SimSun），
// 在 Mac 上会落到系统默认字体。这里补上同族字体，只影响显示：
// 导出时 docx.js 仍取第一个名字，写回 DOCX 的还是原来的 Windows 字体。
const MAC_FONT_FALLBACKS = {
  dengxian: 'PingFang SC',
  '等线': 'PingFang SC',
  'microsoft yahei': 'PingFang SC',
  '微软雅黑': 'PingFang SC',
  simsun: 'Songti SC, STSong',
  '宋体': 'Songti SC, STSong',
  simhei: 'Heiti SC, STHeiti',
  '黑体': 'Heiti SC, STHeiti',
  fangsong: 'STFangsong',
  '仿宋': 'STFangsong',
  kaiti: 'Kaiti SC, STKaiti',
  '楷体': 'Kaiti SC, STKaiti',
  consolas: 'Menlo, "SF Mono"'
}

function applyMacFontFallback (json) {
  if (!isMac || !json) return json
  const walk = (node) => {
    for (const mark of node.marks || []) {
      if (mark.type !== 'textStyle') continue
      const family = mark.attrs?.fontFamily
      if (!family || family.includes(',')) continue
      const key = family.replace(/["']/g, '').trim().toLowerCase()
      const fallback = MAC_FONT_FALLBACKS[key]
      if (!fallback) continue
      mark.attrs = { ...mark.attrs, fontFamily: `${family}, ${fallback}` }
    }
    for (const child of node.content || []) walk(child)
  }
  walk(json)
  return json
}

function resetDocumentPosition () {
  editor.chain().focus().setTextSelection(1).run()
  const workspace = document.querySelector('#workspace')
  workspace.scrollTop = 0
  requestAnimationFrame(() => { workspace.scrollTop = 0 })
}

async function canDiscardChanges () {
  if (!dirty) return true
  // 新版本提供三选一：保存 / 不保存 / 取消；旧 preload 回退到二选一
  if (fileApi.confirmSaveChanges) {
    const choice = await fileApi.confirmSaveChanges()
    if (choice === 'cancel') return false
    if (choice === 'save') return await saveDocument()
    return true
  }
  return fileApi.confirmAction('当前文档有未保存的更改，继续将丢失这些更改。是否继续？')
}

function applyDefaultStyles () {
  const root = document.documentElement
  root.style.setProperty('--doc-font-family', settings.fontFamily)
  root.style.setProperty('--doc-font-size', `${settings.fontSize}pt`)
  root.style.setProperty('--doc-line-height', settings.lineHeight)
  updateDefaultFormatLabels()
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
  txtWarningAccepted = false
  pageSetup = pageSetupFromSettings()
  setEditorJSON({ type: 'doc', content: [{ type: 'paragraph' }] })
  applyPageSetup()
  dirty = false
  updateDocumentState()
  await fileApi.clearAutosave()
  showStatus('已新建文档')
  resetDocumentPosition()
}

// Mac 的 ⌘N 是「新建窗口」：当前窗口内容和未保存状态都不动，
// 直接复用例外的开窗入口（与访达打开文件同一个 create_document_window）。
async function newDocumentOrWindow () {
  if (!isMac || !fileApi.newWindow) {
    await newDocument()
    return
  }
  try {
    await fileApi.newWindow()
  } catch (error) {
    showStatus(`新建窗口失败：${error.message}`, 0)
  }
}

async function loadFile (filePath) {
  try {
    const format = formatFromPath(filePath)
    if (!format) throw new Error('仅支持 .docx 和 .txt 文件')
    const data = await fileApi.readFile(filePath, format === 'docx')
    let json
    let importedPageSetup = null
    let wrapNotice = ''
    if (format === 'docx') {
      const result = await docxBase64ToJSON(data, editorExtensions, {
        defaultFontFamily: settings.fontFamily,
        resolveFontFamily: fontFamilyFromName
      })
      json = applyMacFontFallback(result.json)
      importedPageSetup = result.pageSetup
      wrapNotice = result.wrapNotice || ''
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
    txtWarningAccepted = false
    dirty = false
    updateDocumentState()
    await fileApi.clearAutosave()
    addRecentFile(filePath)
    const imported = format === 'docx' ? 'DOCX 已导入；部分复杂对象可能已简化或忽略' : `已打开 ${currentFileName}`
    // 有图片环绕降级时一并提示，别让「已导入」把它盖掉
    showStatus(wrapNotice ? `${imported}。${wrapNotice}` : imported, format === 'docx' ? 8000 : 5000)
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

// 来自“打开方式”、拖放或 macOS Finder 的文档
async function openDocumentPath (filePath) {
  if (!filePath) return false
  if (!await canDiscardChanges()) return false
  return loadFile(filePath)
}

// 外部打开：已有文档时新开独立窗口，空窗口时原地打开
let openingExternal = false
function openExternalDocument (filePath) {
  if (!filePath || openingExternal) return
  openingExternal = true
  setTimeout(() => { openingExternal = false }, 1200)
  if ((currentPath || dirty) && fileApi.openInNewWindow) {
    showStatus('正在新窗口打开…')
    Promise.resolve(fileApi.openInNewWindow(filePath))
      .catch((error) => showStatus(`打开失败：${error.message}`, 0))
    return
  }
  openDocumentPath(filePath)
}

/* ---------------- 拖放打开 ---------------- */

const DRAG_DOCUMENT_PATTERN = /\.(docx|txt)$/i
let dragDepth = 0

// 拖进来的图片按拖放点落进正文。位置取不到就插在光标处
async function insertDroppedImage (filePath, event) {
  const at = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })
  if (at) editor.chain().focus().setTextSelection(at.pos).run()
  await insertImageFromPath(filePath)
  dirty = true
  updateDocumentState()
  showStatus(`已插入图片 ${fileNameFromPath(filePath)}`, 4000)
}

function clearDragState () {
  dragDepth = 0
  document.body.classList.remove('file-drag-over')
}

function hasDraggedFiles (event) {
  const types = event.dataTransfer?.types
  return !!types && Array.prototype.includes.call(types, 'Files')
}

// 捕获阶段处理，避免编辑器或 Chromium 默认行为把文件当导航/下载
document.addEventListener('dragenter', (event) => {
  if (window.__TAURI__ || !hasDraggedFiles(event)) return
  event.preventDefault()
  event.stopPropagation()
  dragDepth += 1
  document.body.classList.add('file-drag-over')
}, true)

document.addEventListener('dragover', (event) => {
  if (window.__TAURI__ || !hasDraggedFiles(event)) return
  event.preventDefault()
  event.stopPropagation()
  event.dataTransfer.dropEffect = 'copy'
}, true)

document.addEventListener('dragleave', (event) => {
  if (window.__TAURI__ || !hasDraggedFiles(event)) return
  event.preventDefault()
  event.stopPropagation()
  dragDepth = Math.max(0, dragDepth - 1)
  if (!dragDepth) document.body.classList.remove('file-drag-over')
}, true)

document.addEventListener('drop', async (event) => {
  if (window.__TAURI__ || !hasDraggedFiles(event)) return
  event.preventDefault()
  event.stopPropagation()
  clearDragState()
  if (document.querySelector('dialog[open]')) {
    showStatus('请先关闭当前对话框再打开文档', 0)
    return
  }
  const files = Array.from(event.dataTransfer?.files || [])
  if (files.length !== 1) {
    showStatus(files.length ? '一次只能打开一个文档' : '没有识别到文件', 0)
    return
  }
  const filePath = fileApi.getPathForFile?.(files[0])
  if (!filePath) {
    showStatus('无法读取文件路径，请用“打开”按钮选择文件', 0)
    return
  }
  // 图片按松手位置插进正文（只认浏览器拖放；Tauri 的原生拖放开不了 DOM dataTransfer）
  if (IMAGE_PATH_PATTERN.test(filePath)) {
    if (imageEdit || editor.isReadOnly) return
    insertDroppedImage(filePath, event).catch((error) => {
      console.error(error)
      showStatus(`图片插入失败：${error.message}`, 0)
    })
    return
  }
  if (!DRAG_DOCUMENT_PATTERN.test(filePath)) {
    showStatus('仅支持拖入 .docx / .txt 文档，或 png / jpg / gif / bmp 图片', 0)
    return
  }
  openExternalDocument(filePath)
}, true)

// Tauri 下文件拖放走原生事件（DOM drop 根本不会来），图片和文档在这里分流
fileApi.onDragDrop?.(({ paths, x, y }) => {
  const first = paths[0]
  if (!first) return
  if (paths.length > 1) {
    showStatus('一次只能拖入一个文件', 0)
    return
  }
  if (IMAGE_PATH_PATTERN.test(first)) {
    if (imageEdit || editor.isReadOnly) return
    insertDroppedImage(first, { clientX: x, clientY: y }).catch((error) => {
      console.error(error)
      showStatus(`图片插入失败：${error.message}`, 0)
    })
    return
  }
  if (!DRAG_DOCUMENT_PATTERN.test(first)) {
    showStatus('仅支持拖入 .docx / .txt 文档，或 png / jpg / gif / bmp 图片', 0)
    return
  }
  openExternalDocument(first)
})

async function saveDocument (saveAs = false) {
  if (saveInProgress) return false
  saveInProgress = true
  const savedDoc = editor.state.doc
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
    if (format === 'txt' && !txtWarningAccepted && hasRichFormatting(json)) {
      const proceed = await fileApi.confirmAction('保存为 .txt 会丢失格式、图片和表格，确定继续？')
      if (!proceed) return false
    }
    const data = format === 'txt'
      ? (json.content || []).map(plainBlock).join('\n')
      : await jsonToDocxBase64(json, pageSetup, settings)
    await fileApi.writeFile(filePath, data, format === 'docx')
    currentPath = filePath
    currentFileName = fileNameFromPath(filePath)
    currentFormat = format
    if (format === 'txt') txtWarningAccepted = true
    // 保存期间用户继续输入时，新内容还没写进文件，不能标记为已保存
    if (editor.state.doc.eq(savedDoc)) {
      dirty = false
      updateDocumentState()
      await fileApi.clearAutosave().catch(() => {})
    }
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
  // 图片面板开着时文档正被实时预览反复改写，这一份备份等退出编辑再排
  if (imageEdit) return
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
    txtWarningAccepted = false
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
  paginator?.force(0)
  showStatus('设置已保存；默认字体/页面对新文档生效')
})

document.querySelector('#btnResetSettings').addEventListener('click', () => {
  populateSettingsForm(DEFAULT_SETTINGS)
})

const helpTabs = Array.from(document.querySelectorAll('.help-tab'))

function showHelpTab (name) {
  for (const tab of helpTabs) tab.classList.toggle('active', tab.dataset.helpTab === name)
  document.querySelectorAll('.help-panel').forEach((panel) => {
    panel.hidden = panel.id !== `help-panel-${name}`
  })
}

for (const tab of helpTabs) {
  tab.addEventListener('click', () => showHelpTab(tab.dataset.helpTab))
}

function openHelp () {
  showHelpTab('shortcuts')
  if (!helpDialog.open) helpDialog.showModal()
}

document.querySelector('#btnOpenHelp').addEventListener('click', openHelp)
document.querySelector('#btnCloseHelp').addEventListener('click', () => helpDialog.close())
document.querySelector('#helpVersion').textContent = `版本 ${window.wordlite.appInfo?.version || '1.2.0'}`

/* ---------------- 查找替换 ---------------- */

const findBar = document.querySelector('#findBar')
const findInput = document.querySelector('#findInput')
const replaceInput = document.querySelector('#replaceInput')
const replaceRow = document.querySelector('#replaceRow')
const findCount = document.querySelector('#findCount')
const btnFindCase = document.querySelector('#btnFindCase')

// 单次查找最多收集这么多匹配，避免超大文档把界面拖慢；“全部替换”不受此限制
const MAX_FIND_MATCHES = 1000

let findMatches = []
let findIndex = -1
let findCaseSensitive = false
let findCapped = false
let findRefreshTimer = null

// 把匹配到的字符下标换算成文档位置；段内的图片、换行等原子节点没有文字，会自然跳过
function charPos (segments, index) {
  let acc = 0
  for (const segment of segments) {
    const length = segment.end - segment.start
    if (index < acc + length) return segment.start + (index - acc)
    acc += length
  }
  return null
}

// 逐字符折叠大小写，保证折叠后的字符串和原文等长，下标可以一一对应
function foldCase (text) {
  let folded = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const lower = ch.toLowerCase()
    folded += lower.length === ch.length ? lower : ch
  }
  return folded
}

// 按文本块收集匹配：同一段落里跨加粗/斜体等格式也能命中，但不会跨段落，
// 也不会跨过硬换行/图片等非文本节点
function collectFindMatches (query, caseSensitive, limit = MAX_FIND_MATCHES) {
  const matches = []
  let capped = false
  if (!query) return { matches, capped }
  const needle = caseSensitive ? query : foldCase(query)

  editor.state.doc.descendants((node, pos) => {
    if (capped) return false
    if (!node.isTextblock) return true

    let segments = []
    let text = ''

    const searchRun = () => {
      if (!text || capped) return
      const haystack = caseSensitive ? text : foldCase(text)
      let at = haystack.indexOf(needle)
      while (at !== -1) {
        if (matches.length >= limit) {
          capped = true
          break
        }
        const from = charPos(segments, at)
        const last = charPos(segments, at + needle.length - 1)
        if (from != null && last != null) matches.push({ from, to: last + 1 })
        at = haystack.indexOf(needle, at + Math.max(1, needle.length))
      }
      segments = []
      text = ''
    }

    node.forEach((child, offset) => {
      if (!child.isText) {
        searchRun()
        return
      }
      const start = pos + 1 + offset
      segments.push({ start, end: start + child.text.length })
      text += child.text
    })
    searchRun()
    return false
  })

  return { matches, capped }
}

function positionFindBar () {
  const bottom = document.querySelector('#ribbon').getBoundingClientRect().bottom
  findBar.style.top = `${Math.round(bottom + 12)}px`
}

function renderFindDecorations () {
  editor.view.dispatch(editor.state.tr.setMeta(findHighlightKey, {
    ranges: findMatches,
    active: findIndex
  }))
}

function updateFindCount () {
  const query = findInput.value
  findInput.classList.toggle('no-result', !!query && !findMatches.length)
  if (!query) {
    findCount.textContent = ''
    return
  }
  if (!findMatches.length) {
    findCount.textContent = '无结果'
    return
  }
  const total = findCapped ? `${findMatches.length}+` : String(findMatches.length)
  findCount.textContent = `${findIndex + 1}/${total}`
}

function refreshFind ({ keepIndex = false, select = true } = {}) {
  clearTimeout(findRefreshTimer)
  findRefreshTimer = null

  const query = findInput.value
  const previous = keepIndex && findMatches[findIndex] ? findMatches[findIndex] : null
  const result = collectFindMatches(query, findCaseSensitive)
  findMatches = result.matches
  findCapped = result.capped

  if (!query || !findMatches.length) {
    findIndex = -1
  } else if (previous) {
    const at = findMatches.findIndex((match) => match.from >= previous.from)
    findIndex = at >= 0 ? at : findMatches.length - 1
  } else {
    const head = editor.state.selection.head
    const at = findMatches.findIndex((match) => match.from >= head)
    findIndex = at >= 0 ? at : 0
  }

  updateFindCount()
  renderFindDecorations()
  if (select && query && findIndex >= 0) selectFindMatch(findIndex)
}

function scheduleFindRefresh () {
  clearTimeout(findRefreshTimer)
  findRefreshTimer = setTimeout(() => {
    findRefreshTimer = null
    // 正在文档里编辑时只更新高亮，不把光标抢到匹配处
    if (!findBar.hidden) refreshFind({ keepIndex: true, select: false })
  }, 60)
}

function selectFindMatch (index) {
  const match = findMatches[index]
  if (!match) return
  findIndex = index
  editor.view.dispatch(editor.state.tr
    .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
    .scrollIntoView()
    .setMeta(findHighlightKey, { ranges: findMatches, active: findIndex }))
  updateFindCount()
}

function goToFind (delta) {
  if (!findMatches.length) return
  let next
  if (findIndex < 0) next = delta > 0 ? 0 : findMatches.length - 1
  else next = ((findIndex + delta) % findMatches.length + findMatches.length) % findMatches.length
  selectFindMatch(next)
}

function openFind (mode = 'find') {
  const wasHidden = findBar.hidden
  // 先显示再刷新：即使 refreshFind 抛异常，查找栏也不会打不开
  findBar.hidden = false
  positionFindBar()
  if (wasHidden) {
    try {
      const { from, to } = editor.state.selection
      if (to > from) {
        const selected = editor.state.doc.textBetween(from, to, '\n', ' ')
        if (selected && !/[\r\n]/.test(selected) && selected.length <= 200) findInput.value = selected
      }
      refreshFind()
    } catch (error) {
      console.error(error)
    }
  }
  if (mode === 'replace') {
    replaceRow.hidden = false
    replaceInput.focus()
    replaceInput.select()
  } else {
    findInput.focus()
    findInput.select()
  }
}

function closeFind () {
  if (findBar.hidden) return
  findBar.hidden = true
  replaceRow.hidden = true
  clearTimeout(findRefreshTimer)
  findRefreshTimer = null
  findMatches = []
  findIndex = -1
  findCapped = false
  editor.view.dispatch(editor.state.tr.setMeta(findHighlightKey, { ranges: [], active: -1 }))
  editor.chain().focus().run()
}

// 替换文本继承被替换处开头的 marks；空文本直接删除
function replaceMatch (tr, match, text) {
  if (!text) {
    tr.delete(match.from, match.to)
    return
  }
  const marks = editor.state.doc.resolve(match.from).marks()
  tr.replaceWith(match.from, match.to, editor.state.schema.text(text, marks))
}

function replaceCurrent () {
  if (!findMatches.length || findIndex < 0) return
  const match = findMatches[findIndex]
  const text = replaceInput.value.replace(/[\r\n]+/g, ' ')
  const tr = editor.state.tr.setStoredMarks(null)
  replaceMatch(tr, match, text)
  editor.view.dispatch(tr)
  refreshFind({ keepIndex: true })
  if (findMatches.length) {
    const next = findMatches.findIndex((item) => item.from >= match.from + text.length)
    selectFindMatch(next >= 0 ? next : 0)
  }
  showStatus('已替换 1 处')
  replaceInput.focus()
}

function replaceAll () {
  const query = findInput.value
  if (!query) return
  const { matches } = collectFindMatches(query, findCaseSensitive, Infinity)
  if (!matches.length) return
  const text = replaceInput.value.replace(/[\r\n]+/g, ' ')
  const tr = editor.state.tr.setStoredMarks(null)
  for (let i = matches.length - 1; i >= 0; i--) replaceMatch(tr, matches[i], text)
  editor.view.dispatch(tr)
  refreshFind()
  showStatus(`已替换 ${matches.length} 处`)
  replaceInput.focus()
}

document.querySelector('#btnFind').addEventListener('click', () => openFind('find'))
document.querySelector('#btnReplace').addEventListener('click', () => openFind('replace'))
document.querySelector('#btnFindPrev').addEventListener('click', () => goToFind(-1))
document.querySelector('#btnFindNext').addEventListener('click', () => goToFind(1))
document.querySelector('#btnFindClose').addEventListener('click', closeFind)
document.querySelector('#btnReplaceOne').addEventListener('click', replaceCurrent)
document.querySelector('#btnReplaceAll').addEventListener('click', replaceAll)

btnFindCase.addEventListener('click', () => {
  findCaseSensitive = !findCaseSensitive
  btnFindCase.classList.toggle('active', findCaseSensitive)
  refreshFind({ keepIndex: true })
  findInput.focus()
})

findInput.addEventListener('input', () => refreshFind())
findInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter') {
    e.preventDefault()
    goToFind(e.shiftKey ? -1 : 1)
  }
})

replaceInput.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter') {
    e.preventDefault()
    replaceCurrent()
  }
})

new ResizeObserver(positionFindBar).observe(document.querySelector('#ribbon'))

/* ---------------- 打印与 PDF ---------------- */

// Ctrl+P / 功能区「打印」/ Mac 菜单都走这里：一步到 WebView2 原生打印页。
// 原生页有自己的预览、页码、份数、打印机和真实页数，简写不再自己排一遍。
let printing = false
let printRestoreFocus = false
let printFallbackTimer = 0
// Mac 显式纸张导出期间，打印媒体下的自然分页和屏幕分页不是一套；
// 这期间不能再按打印布局重排屏幕分页，否则导出完页数会乱。
let explicitPrintActive = false

function endPrint () {
  if (printFallbackTimer) {
    clearTimeout(printFallbackTimer)
    printFallbackTimer = 0
  }
  if (!printing) return
  printing = false
  document.body.classList.remove('printing')
  fileApi.setPrintingMode?.(false)
  // 打印期间 beforeprint 可能按打印布局重排过一次，回到屏幕后恢复真实分页
  if (!explicitPrintActive) paginator?.force(0)
  if (printRestoreFocus) {
    printRestoreFocus = false
    editor.commands.focus()
  }
}

// 原生打印页关闭（或在 Mac 上根本不发 afterprint）时把状态复位
window.addEventListener('afterprint', endPrint)

async function directPrint () {
  // 原生打印页开着时 window.print() 是阻塞的，printing 标志挡住重复调用
  if (printing || document.querySelector('dialog[open]')) return
  printing = true
  printRestoreFocus = editor.view.hasFocus()
  document.body.classList.add('printing')
  // 原生层在打印期间挡住窗口关闭，免得点 X 把文档窗口关掉
  try {
    await fileApi.setPrintingMode?.(true)
  } catch (error) {
    console.error(error)
  }
  // 最后一次编辑可能还在 180ms 防抖里；打印前强制重排，保证打印和屏幕同一套断点
  paginator?.runNow()
  try {
    await clearPrintFocus()
  } catch (error) {
    console.error(error)
    endPrint()
    return
  }
  try {
    // Windows 上 eval("window.print()") 是异步返回的，afterprint 才是关闭信号；
    // Mac 的 NSPrintPanel 可能不发 afterprint，3 秒后兜底复位，避免永远卡住。
    // Windows 的兜底放长：打印面板开着的时候不能提前解除关闭保护。
    await fileApi.print()
    printFallbackTimer = setTimeout(endPrint, isMac ? 3000 : 120000)
  } catch (error) {
    console.error(error)
    endPrint()
    showStatus('无法打开打印窗口，请更新 WebView2 运行时，或改用「导出 PDF」', 0)
  }
}

document.querySelector('#btnPrint').addEventListener('click', directPrint)

// 兜底：以后若有入口绕过 directPrint 直接触发 window.print()，输出里也不该有光标和选区。
// directPrint 自己也会触发 beforeprint，此时不能再记一次焦点（焦点已经被 clearPrintFocus 移走了）
window.addEventListener('beforeprint', () => {
  if (printing) return
  printing = true
  printRestoreFocus = editor.view.hasFocus()
  document.body.classList.add('printing')
  fileApi.setPrintingMode?.(true)
  if (!explicitPrintActive) paginator?.runNow()
  clearPrintFocus().catch(() => {})
})

// 打印/导出 PDF 前先让编辑器失焦并清掉选区：WKWebView 会把编辑光标和选区高亮
// 一起画进 PDF（短文档第一次导出时末尾会多出一条蓝色竖线）。
async function clearPrintFocus () {
  const active = document.activeElement
  if (active && active !== document.body && typeof active.blur === 'function') active.blur()
  try {
    window.getSelection()?.removeAllRanges()
  } catch {
    // 选区 API 不可用时忽略，打印样式里还有 caret-color: transparent 兜底
  }
  // 等两帧，确保失焦和重绘完成后再交给打印引擎
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/* ---------------- Mac 导出 PDF：屏幕分页捕获 ----------------
   WKWebView 的打印排版会重新排正文（每页末尾会少几段），@page 页边距盒子也不生效。
   导出时把屏幕上的纸张整体缩到 A4 点数（96 CSS px/inch → 72 pt/inch），
   逐页 createPDF（屏幕媒体，不重排），最后用 PDFKit 合并成一份 PDF。 */

const PDF_CAPTURE_SCALE = 0.75

function beginPdfCapture () {
  if (!isMac) return null
  const paper = document.querySelector('.paper')
  const scaler = document.querySelector('#paperScaler')
  if (!paper || !scaler) return null

  // 连续阅读时页层是空的；临时切回分页纸张，导完再恢复
  const wasReading = pageGapCollapsed
  if (wasReading) {
    pageGapCollapsed = false
    paginator.runNow()
  }
  paginator.runNow()

  pdfCaptureActive = true
  document.documentElement.classList.add('pdf-capture')
  document.body.classList.add('pdf-capture')
  if (pageSetup.pageNumber !== 'print') {
    document.body.classList.add('pdf-capture-no-numbers')
  }

  paper.style.transformOrigin = 'top left'
  paper.style.transform = `scale(${PDF_CAPTURE_SCALE})`
  scaler.style.width = `${(paper.offsetWidth * PDF_CAPTURE_SCALE).toFixed(2)}px`
  scaler.style.height = `${(paper.offsetHeight * PDF_CAPTURE_SCALE).toFixed(2)}px`
  // 先把布局定下来，再量每张纸在文档里的位置
  void paper.offsetHeight
  const rects = Array.from(document.querySelectorAll('.page-layer .page-sheet')).map((sheet) => {
    const rect = sheet.getBoundingClientRect()
    return {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height
    }
  })
  return { wasReading, rects }
}

function finishPdfCapture (state) {
  if (!state) return
  pdfCaptureActive = false
  document.documentElement.classList.remove('pdf-capture')
  document.body.classList.remove('pdf-capture', 'pdf-capture-no-numbers')
  const paper = document.querySelector('.paper')
  if (paper) paper.style.transformOrigin = ''
  // 恢复用户当前的页面缩放，外层 scaler 也一起恢复
  renderPageZoom(pageZoom)
  if (pageGapCollapsed !== state.wasReading) {
    pageGapCollapsed = state.wasReading
    paginator.runNow()
  } else {
    paginator.force(0)
  }
}

// 自测入口：让 CI 能单独生成一份带页眉页脚页码的屏幕捕获 PDF
window.__wordlitePdfCapture = {
  prepare: () => beginPdfCapture(),
  finish: (state) => finishPdfCapture(state)
}

async function exportPdf () {
  const editorHadFocus = editor.view.hasFocus()
  // 和打印一样：先把分页排到最新，导出的 PDF 才和屏幕逐页一致
  paginator?.runNow()
  await clearPrintFocus()
  const defaultPath = `${currentFileName.replace(/\.[^.]+$/, '')}.pdf`
  let capture = null
  try {
    if (isMac) capture = beginPdfCapture()
    const result = capture
      ? await fileApi.exportPdfCapture(defaultPath, capture.rects, null)
      : await fileApi.exportPdf(defaultPath)
    if (result?.saved) showStatus(`PDF 已导出：${result.path}`)
  } catch (error) {
    showStatus(`PDF 导出失败：${error.message}`, 0)
  } finally {
    finishPdfCapture(capture)
    // 导出走完后把焦点还给编辑器（打印面板期间不抢焦点，避免光标重新出现在打印内容里）
    if (editorHadFocus) editor.commands.focus()
  }
}

document.querySelector('#btnExportPdf').addEventListener('click', exportPdf)

/* ---------------- 菜单命令（macOS 菜单栏） ---------------- */

// 焦点在查找/替换输入框时，撤销/重做交给输入框自己处理
function runHistory (direction) {
  if (isFormTarget(document.activeElement)) {
    document.execCommand(direction)
    return
  }
  const chain = editor.chain().focus()
  if (direction === 'undo') chain.undo().run()
  else chain.redo().run()
}

// 标签栏右侧常驻的撤销/重做：按钮禁用态直接读 ProseMirror 历史栈
const btnUndo = document.querySelector('#btnUndo')
const btnRedo = document.querySelector('#btnRedo')

function updateHistoryButtons () {
  if (!btnUndo || !btnRedo) return
  btnUndo.disabled = undoDepth(editor.state) === 0
  btnRedo.disabled = redoDepth(editor.state) === 0
}

if (btnUndo && btnRedo) {
  btnUndo.title = isMac ? '撤销 (⌘Z)' : '撤销 (Ctrl+Z)'
  btnRedo.title = isMac ? '重做 (⇧⌘Z)' : '重做 (Ctrl+Shift+Z)'
  // 按下时不抢走输入框/正文的焦点：查找框里的撤销仍然作用于输入框
  for (const button of [btnUndo, btnRedo]) {
    button.addEventListener('mousedown', (event) => event.preventDefault())
  }
  btnUndo.addEventListener('click', () => runHistory('undo'))
  btnRedo.addEventListener('click', () => runHistory('redo'))
  editor.on('transaction', updateHistoryButtons)
  updateHistoryButtons()
}

// Rust 端菜单点击后按约定发 menu-command，这里分发到已有函数
const MENU_COMMANDS = {
  new: () => newDocumentOrWindow(),
  open: () => openDocument(),
  save: () => saveDocument(),
  saveAs: () => saveDocument(true),
  exportPdf: () => exportPdf(),
  print: () => directPrint(),
  undo: () => runHistory('undo'),
  redo: () => runHistory('redo'),
  find: () => openFind('find'),
  replace: () => openFind('replace'),
  help: () => openHelp()
}

fileApi.onMenuCommand?.((id) => {
  const run = MENU_COMMANDS[id]
  if (run) run()
})

/* ---------------- 启动 ---------------- */

document.querySelector('#btnNew').addEventListener('click', newDocumentOrWindow)
document.querySelector('#btnOpen').addEventListener('click', openDocument)
document.querySelector('#btnSave').addEventListener('click', () => saveDocument())
document.querySelector('#btnSaveAs').addEventListener('click', () => saveDocument(true))

// Tauri 的拖放会同时走 onOpenFile 和 onDragDrop：图片归 onDragDrop 插进正文，
// 这里必须把它筛掉，否则拖一张 png 进来会顺手再开一个「打不开的文档窗口」
fileApi.onOpenFile((filePath) => {
  if (IMAGE_PATH_PATTERN.test(filePath)) return
  openExternalDocument(filePath)
})

let closePrompting = false
fileApi.onSaveBeforeClose(async () => {
  if (closePrompting) return
  closePrompting = true
  // 窗口最终有没有关掉。没关掉（取消、另存为被取消、写盘失败、抛异常）都要
  // 通知 Rust 中止退出流程，否则 quitting 一直为 true，之后手动关窗口会把其余窗口一起关掉。
  // Windows 上 closeCancelled 什么也不做。
  let closed = false
  try {
    if (!dirty) {
      closed = true
      fileApi.closeAfterSave()
      return
    }
    const choice = await fileApi.confirmSaveChanges()
    if (choice === 'save') {
      // 另存为被取消或写盘失败时窗口保持打开
      if (await saveDocument()) {
        closed = true
        fileApi.closeAfterSave()
      }
    } else if (choice === 'discard') {
      await fileApi.clearAutosave().catch(() => {})
      closed = true
      fileApi.closeAfterSave()
    }
  } catch (error) {
    console.error(error)
  } finally {
    if (!closed) {
      try {
        await fileApi.closeCancelled?.()
      } catch {
        // 旧版 Rust 没有该命令，忽略即可
      }
    }
    closePrompting = false
  }
})

/* ---------------- 状态栏 ---------------- */

function updateStatusBar () {
  const n = editor.storage.characterCount.characters()
  document.querySelector('#wordCount').textContent = `字数 ${n}`
}

// 设置里的默认字体/字号/行距只作用于未单独设格式的文字；新文档优先采用这些默认值
localizeShortcuts()
applyDefaultStyles()
populateSettingsForm()
renderRecentFiles()
updateStatusBar()
syncToolbar()
updateDocumentState()
applyPageSetup()
applyPageZoom(pageZoom)
scheduleAutoSave()
// 自动备份恢复询问结束后再收“打开方式”的文档，避免两个对话框同时弹出
async function finishStartup () {
  await restoreAutosave()
  // 主窗口负责把上次残留的 doc 自动保存逐个开窗，由各窗口自己提示恢复
  if (window.wordlite.appInfo?.label === 'main' && fileApi.listOrphanAutosaves && fileApi.restoreOrphanAutosave) {
    try {
      const labels = await fileApi.listOrphanAutosaves()
      for (const label of labels || []) {
        await fileApi.restoreOrphanAutosave(label).catch(() => {})
      }
    } catch (error) {
      console.error(error)
    }
  }
  fileApi.notifyReady()
}

finishStartup()
