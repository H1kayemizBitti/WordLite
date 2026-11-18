// 自定义 TipTap 扩展：缩进、段距、字距、行距、字号、上下标、图片、表格
// Word 的语义是"段落/字符属性"，官方扩展没有现成的，按需自行实现
import { Extension, Mark, Node, ResizableNodeView, getRenderedAttributes, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Image as BaseImage } from '@tiptap/extension-image'
import { Table as BaseTable, TableView as BaseTableView } from '@tiptap/extension-table'
import { TableCell as BaseTableCell } from '@tiptap/extension-table-cell'
import { TableHeader as BaseTableHeader } from '@tiptap/extension-table-header'
import { Strike as BaseStrike } from '@tiptap/extension-strike'

const BLOCKS = ['paragraph', 'heading']
const clampIndent = (v) => Math.max(0, Math.min(8, Number(v) || 0))
const numberAttr = (value) => {
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : null
}

export const Indent = Extension.create({
  name: 'indent',

  addGlobalAttributes () {
    return [{
      types: BLOCKS,
      attributes: {
        indent: {
          default: 0,
          parseHTML: (el) => Number(el.getAttribute('data-indent')) || 0,
          renderHTML: (attrs) => attrs.indent
            ? { 'data-indent': attrs.indent, style: `margin-left:${attrs.indent * 2}em` }
            : {}
        }
      }
    }]
  },

  addCommands () {
    const apply = (delta) => ({ tr, state, dispatch }) => {
      const { from, to } = state.selection
      let changed = false
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!BLOCKS.includes(node.type.name)) return
        const next = clampIndent((node.attrs.indent || 0) + delta)
        if (next !== node.attrs.indent) {
          changed = true
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next })
        }
      })
      return changed
    }
    return {
      indent: () => apply(1),
      outdent: () => apply(-1),
      setIndentTo: (value) => ({ tr, state, dispatch }) => {
        const nextValue = clampIndent(value)
        let changed = false
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
          if (!BLOCKS.includes(node.type.name) || node.attrs.indent === nextValue) return
          changed = true
          if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: nextValue })
        })
        return changed
      }
    }
  },

  addKeyboardShortcuts () {
    return {
      'Mod-]': () => this.editor.commands.indent(),
      'Mod-[': () => this.editor.commands.outdent()
    }
  }
})

// 字体间距：v3 官方包没有稳定版，按 textStyle 属性自行实现
export const FontSize = Extension.create({
  name: 'fontSize',

  addGlobalAttributes () {
    return [{
      types: ['textStyle'],
      attributes: {
        fontSize: {
          default: null,
          parseHTML: (el) => el.style.fontSize || null,
          renderHTML: (attrs) => attrs.fontSize ? { style: `font-size:${attrs.fontSize}` } : {}
        }
      }
    }]
  },

  addCommands () {
    return {
      setFontSize: (size) => ({ chain }) =>
        chain().setMark('textStyle', { fontSize: size }).run(),
      unsetFontSize: () => ({ chain }) =>
        chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run()
    }
  }
})

export const LetterSpacing = Extension.create({
  name: 'letterSpacing',

  addGlobalAttributes () {
    return [{
      types: ['textStyle'],
      attributes: {
        letterSpacing: {
          default: null,
          parseHTML: (el) => {
            const value = Number.parseFloat(el.style.letterSpacing)
            return Number.isFinite(value) ? value : null
          },
          renderHTML: (attrs) => Number.isFinite(attrs.letterSpacing)
            ? { style: `letter-spacing:${attrs.letterSpacing}pt` }
            : {}
        }
      }
    }]
  },

  addCommands () {
    return {
      setLetterSpacing: (value) => ({ chain }) =>
        chain().setMark('textStyle', { letterSpacing: value }).run(),
      unsetLetterSpacing: () => ({ chain }) =>
        chain().setMark('textStyle', { letterSpacing: null }).removeEmptyTextStyle().run()
    }
  }
})

export const ParagraphSpacing = Extension.create({
  name: 'paragraphSpacing',

  addGlobalAttributes () {
    return [{
      types: BLOCKS,
      attributes: {
        spacingBefore: {
          default: null,
          parseHTML: (el) => {
            const value = Number.parseFloat(el.getAttribute('data-spacing-before'))
            return Number.isFinite(value) ? value : null
          },
          renderHTML: (attrs) => Number.isFinite(attrs.spacingBefore)
            ? { 'data-spacing-before': attrs.spacingBefore, style: `margin-top:${attrs.spacingBefore}pt` }
            : {}
        },
        spacingAfter: {
          default: null,
          parseHTML: (el) => {
            const value = Number.parseFloat(el.getAttribute('data-spacing-after'))
            return Number.isFinite(value) ? value : null
          },
          renderHTML: (attrs) => Number.isFinite(attrs.spacingAfter)
            ? { 'data-spacing-after': attrs.spacingAfter, style: `margin-bottom:${attrs.spacingAfter}pt` }
            : {}
        }
      }
    }]
  },

  addCommands () {
    return {
      setBlockSpacing: (patch) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection
        let changed = false
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!BLOCKS.includes(node.type.name)) return
          const next = { ...node.attrs }
          let nodeChanged = false
          for (const key of ['spacingBefore', 'spacingAfter']) {
            if (!(key in patch)) continue
            const value = patch[key] === '' || patch[key] === null ? null : Math.max(0, Math.min(200, Number(patch[key]) || 0))
            if (next[key] !== value) {
              next[key] = value
              nodeChanged = true
            }
          }
          if (nodeChanged) {
            changed = true
            if (dispatch) tr.setNodeMarkup(pos, undefined, next)
          }
        })
        return changed
      }
    }
  }
})

export const LineHeight = Extension.create({
  name: 'lineHeight',

  addGlobalAttributes () {
    return [{
      types: BLOCKS,
      attributes: {
        lineHeight: {
          default: null,
          parseHTML: (el) => el.getAttribute('data-line-height'),
          renderHTML: (attrs) => attrs.lineHeight
            ? { 'data-line-height': attrs.lineHeight, style: `line-height:${attrs.lineHeight}` }
            : {}
        }
      }
    }]
  },

  addCommands () {
    return {
      setLineHeight: (value) => ({ tr, state, dispatch }) => {
        const { from, to } = state.selection
        let changed = false
        state.doc.nodesBetween(from, to, (node, pos) => {
          if (!BLOCKS.includes(node.type.name)) return
          if (node.attrs.lineHeight !== value) {
            changed = true
            if (dispatch) tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight: value })
          }
        })
        return changed
      }
    }
  }
})

// 上标 / 下标
export const Superscript = Mark.create({
  name: 'superscript',
  excludes: 'subscript',

  parseHTML () {
    return [{ tag: 'sup' }, { style: 'vertical-align=super' }]
  },

  renderHTML () {
    return ['sup', { 'data-superscript': '' }, 0]
  },

  addCommands () {
    return {
      toggleSuperscript: () => ({ commands }) => commands.toggleMark(this.name),
      unsetSuperscript: () => ({ commands }) => commands.unsetMark(this.name)
    }
  }
})

export const Subscript = Mark.create({
  name: 'subscript',
  excludes: 'superscript',

  parseHTML () {
    return [{ tag: 'sub' }, { style: 'vertical-align=sub' }]
  },

  renderHTML () {
    return ['sub', { 'data-subscript': '' }, 0]
  },

  addCommands () {
    return {
      toggleSubscript: () => ({ commands }) => commands.toggleMark(this.name),
      unsetSubscript: () => ({ commands }) => commands.unsetMark(this.name)
    }
  }
})

function imageCrop (attrs) {
  const crop = attrs.crop || {}
  const part = (value) => Math.max(0, Math.min(95, Number(value) || 0))
  return {
    top: part(crop.top),
    right: part(crop.right),
    bottom: part(crop.bottom),
    left: part(crop.left)
  }
}

// Word 式"外框 = 可见区域"：width/height 是可见区域的显示尺寸，
// 内部 img 放大到 宽/(1-左右裁剪) 并向上向左偏移，多出来的部分被外框裁掉。
// 没有显式尺寸的旧数据退回原图自然尺寸。
export function imageCropFrame (attrs, natural = null) {
  const crop = imageCrop(attrs)
  const hasCrop = !!(crop.top || crop.right || crop.bottom || crop.left)
  const visibleX = Math.max(0.05, 1 - (crop.left + crop.right) / 100)
  const visibleY = Math.max(0.05, 1 - (crop.top + crop.bottom) / 100)
  const width = Number(attrs.width) || null
  const height = Number(attrs.height) || null
  const frame = {
    crop,
    hasCrop,
    width: null,
    height: null,
    innerWidth: null,
    innerHeight: null,
    left: 0,
    top: 0
  }
  if (width) {
    frame.width = Math.max(1, Math.round(width))
    frame.innerWidth = Math.max(1, Math.round(frame.width / visibleX))
  } else if (natural?.width) {
    frame.innerWidth = natural.width
    if (hasCrop) frame.width = Math.max(1, Math.round(frame.innerWidth * visibleX))
  }
  if (height) {
    frame.height = Math.max(1, Math.round(height))
    frame.innerHeight = Math.max(1, Math.round(frame.height / visibleY))
  } else if (natural?.height) {
    frame.innerHeight = natural.height
    if (hasCrop) frame.height = Math.max(1, Math.round(frame.innerHeight * visibleY))
  }
  if (frame.innerWidth) frame.left = -Math.round(frame.innerWidth * crop.left / 100)
  if (frame.innerHeight) frame.top = -Math.round(frame.innerHeight * crop.top / 100)
  return frame
}

const IMAGE_DATA_ATTRS = [
  'data-align',
  'data-wrap',
  'data-crop-top',
  'data-crop-right',
  'data-crop-bottom',
  'data-crop-left',
  'title',
  'alt'
]

// 图片：精确宽高、对齐、文字环绕、裁剪；保留官方拖拽缩放
export const WordImage = BaseImage.extend({
  addAttributes () {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => numberAttr(el.getAttribute('width')) || numberAttr(el.style.width),
        renderHTML: (attrs) => attrs.width ? { width: attrs.width, style: `width:${attrs.width}px` } : {}
      },
      height: {
        default: null,
        parseHTML: (el) => numberAttr(el.getAttribute('height')) || numberAttr(el.style.height),
        renderHTML: (attrs) => attrs.height ? { height: attrs.height, style: `height:${attrs.height}px` } : {}
      },
      align: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-align') || null,
        renderHTML: (attrs) => ['left', 'center', 'right'].includes(attrs.align)
          ? { 'data-align': attrs.align }
          : {}
      },
      wrap: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-wrap') || null,
        renderHTML: (attrs) => ['left', 'right', 'topBottom'].includes(attrs.wrap)
          ? { 'data-wrap': attrs.wrap }
          : {}
      },
      crop: {
        default: { top: 0, right: 0, bottom: 0, left: 0 },
        parseHTML: (el) => imageCrop({
          crop: {
            top: el.getAttribute('data-crop-top'),
            right: el.getAttribute('data-crop-right'),
            bottom: el.getAttribute('data-crop-bottom'),
            left: el.getAttribute('data-crop-left')
          }
        }),
        renderHTML: (attrs) => {
          const crop = imageCrop(attrs)
          return {
            'data-crop-top': crop.top,
            'data-crop-right': crop.right,
            'data-crop-bottom': crop.bottom,
            'data-crop-left': crop.left
          }
        }
      }
    }
  },

  // img 不再直接做缩放容器：外层 box 承载可见区域尺寸并 overflow:hidden，
  // 对齐 / 环绕标记仍放在 img 上，沿用 style.css 里 :has(img[...]) 的规则。
  addNodeView () {
    if (!this.options.resize || !this.options.resize.enabled || typeof document === 'undefined') return null
    const { directions, minWidth, minHeight, alwaysPreserveAspectRatio } = this.options.resize
    return ({ node, getPos, HTMLAttributes, editor }) => {
      const box = document.createElement('div')
      box.style.display = 'inline-block'
      box.style.verticalAlign = 'top'
      box.style.overflow = 'hidden'
      box.style.lineHeight = '0'
      box.style.boxSizing = 'border-box'
      box.style.maxWidth = '100%'
      const el = document.createElement('img')
      el.draggable = false
      box.appendChild(el)

      const mergedAttributes = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
      const syncImageSource = (src) => {
        if (typeof src === 'string' && src !== '') {
          if (el.getAttribute('src') !== src) el.src = src
          return
        }
        if (el.hasAttribute('src')) el.removeAttribute('src')
      }
      const natural = () => ({
        width: el.naturalWidth || null,
        height: el.naturalHeight || null
      })
      let nodeView = null
      const syncFrame = (attrs) => {
        const frame = imageCropFrame(attrs, natural())
        box.style.width = frame.width ? `${frame.width}px` : ''
        box.style.height = frame.height ? `${frame.height}px` : ''
        el.style.width = frame.innerWidth ? `${frame.innerWidth}px` : 'auto'
        el.style.height = frame.innerHeight ? `${frame.innerHeight}px` : 'auto'
        // style.css 里 img 的 max-width:100% 会把放大后的图缩回去，这里覆盖掉
        el.style.maxWidth = frame.hasCrop || frame.innerWidth ? 'none' : ''
        el.style.transform = frame.hasCrop ? `translate(${frame.left}px, ${frame.top}px)` : ''
        // topBottom：块级、整行；align 交给 style.css 的 :has 规则
        if (nodeView) nodeView.dom.style.clear = attrs.wrap === 'topBottom' ? 'both' : ''
      }
      const syncAttributes = (attributes) => {
        for (const key of IMAGE_DATA_ATTRS) {
          const value = attributes[key]
          if (value == null) el.removeAttribute(key)
          else el.setAttribute(key, value)
        }
        syncImageSource(attributes.src)
      }

      syncAttributes(mergedAttributes)
      syncFrame(node.attrs)

      const onUpdate = (updatedNode) => {
        if (updatedNode.type !== node.type) return false
        const extensionAttributes = editor.extensionManager.attributes.filter((attribute) => attribute.type === updatedNode.type.name)
        syncAttributes(getRenderedAttributes(updatedNode, extensionAttributes))
        syncFrame(updatedNode.attrs)
        return true
      }

      nodeView = new ResizableNodeView({
        element: box,
        editor,
        node,
        getPos,
        onResize: (width, height) => {
          syncFrame({ ...node.attrs, width, height })
        },
        onCommit: (width, height) => {
          const pos = getPos()
          if (pos === void 0) return
          this.editor.chain().setNodeSelection(pos).updateAttributes(this.name, { width, height }).run()
        },
        onUpdate,
        options: {
          directions,
          min: { width: minWidth, height: minHeight },
          preserveAspectRatio: alwaysPreserveAspectRatio === true
        }
      })
      syncFrame(node.attrs)
      const dom = nodeView.dom
      // 容器是 draggable 时，浏览器按「最近的 draggable 祖先」发起原生拖拽，
      // 按在手柄上也会把整张图拖走。手柄自己的 mousedown 会 preventDefault，
      // 但拖拽源在浏览器里更早确定，所以按下手柄时先把容器的 draggable 摘掉，
      // 松开后再交回 ProseMirror（它下次按下时会自己补回来）
      const isHandle = (target) => !!target?.closest?.('[data-resize-handle]')
      dom.addEventListener('mousedown', (event) => {
        if (!isHandle(event.target)) return
        dom.draggable = false
        const restore = () => {
          dom.removeAttribute('draggable')
          document.removeEventListener('mouseup', restore, true)
        }
        document.addEventListener('mouseup', restore, true)
      }, true)
      const showNodeView = () => {
        dom.style.visibility = ''
        dom.style.pointerEvents = ''
      }
      dom.style.visibility = 'hidden'
      dom.style.pointerEvents = 'none'
      if (el.complete && el.naturalWidth > 0) showNodeView()
      else {
        el.onload = showNodeView
        el.onerror = showNodeView
      }
      return nodeView
    }
  }
})

const COLOR_NAMES = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  gray: '#808080',
  grey: '#808080',
  orange: '#ffa500',
  purple: '#800080'
}

// 把 CSS 颜色统一成 #rrggbb；识别不了返回 null，避免把非法值写进 DOCX
export function normalizeHexColor (value) {
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase()
  if (!text) return null
  if (/^#[0-9a-f]{6}$/.test(text)) return text
  if (/^#[0-9a-f]{3}$/.test(text)) {
    return `#${text.slice(1).split('').map((ch) => ch + ch).join('')}`
  }
  const match = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (match) {
    return `#${[match[1], match[2], match[3]]
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0'))
      .join('')}`
  }
  return COLOR_NAMES[text] || null
}

function colorFromElement (el) {
  const value = el.getAttribute('data-cell-background') || el.style.backgroundColor || el.getAttribute('bgcolor')
  return normalizeHexColor(value)
}

function cellBackgroundAttribute () {
  return {
    background: {
      default: null,
      parseHTML: (el) => colorFromElement(el),
      renderHTML: (attrs) => attrs.background
        ? { 'data-cell-background': attrs.background, style: `background-color:${attrs.background}` }
        : {}
    }
  }
}

export const WordTableCell = BaseTableCell.extend({
  addAttributes () {
    return { ...this.parent?.(), ...cellBackgroundAttribute() }
  }
})

export const WordTableHeader = BaseTableHeader.extend({
  addAttributes () {
    return { ...this.parent?.(), ...cellBackgroundAttribute() }
  }
})

// 可调整列宽时 TipTap 会用自带 TableView 接管渲染，它不会应用节点属性，
// 导致边框宽度/颜色只存进文档却看不到。这里补齐 DOM 属性。
export class WordTableView extends BaseTableView {
  constructor (node, cellMinWidth, _view) {
    super(node, cellMinWidth)
    this.applyTableAttributes()
  }

  update (node) {
    if (!super.update(node)) return false
    this.applyTableAttributes()
    return true
  }

  applyTableAttributes () {
    const attrs = this.node.attrs || {}
    const size = Math.max(0, Number(attrs.borderSize) || 0)
    const color = /^#[0-9a-f]{6}$/i.test(attrs.borderColor || '') ? attrs.borderColor : '#bfbfbf'
    this.table.setAttribute('data-border-size', String(attrs.borderSize ?? 0.5))
    this.table.setAttribute('data-border-color', color)
    this.table.style.setProperty('--wl-table-border', size > 0 ? `${size}pt solid ${color}` : 'none')
  }
}

export const WordTable = BaseTable.extend({
  addAttributes () {
    return {
      ...this.parent?.(),
      borderSize: {
        default: 0.5,
        parseHTML: (el) => numberAttr(el.getAttribute('data-border-size')) ?? 0.5,
        renderHTML: (attrs) => ({ 'data-border-size': attrs.borderSize })
      },
      borderColor: {
        default: '#bfbfbf',
        parseHTML: (el) => el.getAttribute('data-border-color') || '#bfbfbf',
        renderHTML: (attrs) => {
          const size = Math.max(0, Number(attrs.borderSize) || 0)
          const color = /^#[0-9a-f]{6}$/i.test(attrs.borderColor || '') ? attrs.borderColor : '#bfbfbf'
          return {
            'data-border-color': color,
            style: `--wl-table-border:${size > 0 ? `${size}pt solid ${color}` : 'none'}`
          }
        }
      }
    }
  }
})

// 删除线快捷键从 Ctrl+Shift+S 改为 Ctrl+Shift+X，把 Ctrl+Shift+S 留给“另存为”
export const StrikeWithShortcut = BaseStrike.extend({
  addKeyboardShortcuts () {
    return { 'Mod-Shift-x': () => this.editor.commands.toggleStrike() }
  }
})

// 直接插入字符，关闭标记语法的自动输入转换
export const PlainTextInput = Extension.create({
  name: 'plainTextInput',

  addProseMirrorPlugins () {
    let composing = false
    let composeEndTimer = null
    const insertedText = (tr) => {
      const parts = []
      for (const step of tr.steps) {
        if (!step.slice?.content) continue
        const text = step.slice.content.textBetween(0, step.slice.content.size, '\n', '\n')
        if (text) parts.push(text)
      }
      return parts.join('')
    }
    return [new Plugin({
      props: {
        handleTextInput: (view, from, to, text) => {
          // 输入法组合期间及刚结束时交给 ProseMirror 原生处理，避免把拼音中间态单独写进撤销历史
          const composingRecently = view.composing ||
            Date.now() - (view.input?.compositionEndedAt || 0) < 1000
          if (composingRecently) return false
          view.dispatch(view.state.tr.insertText(text, from, to))
          return true
        },
        handleDOMEvents: {
          compositionstart: () => {
            composing = true
            clearTimeout(composeEndTimer)
            return false
          },
          compositionend: () => {
            clearTimeout(composeEndTimer)
            composeEndTimer = setTimeout(() => { composing = false }, 50)
            return false
          }
        },
        filterTransaction: (tr) => {
          // 拼音中间态只用于显示，不进撤销栈；上屏后的中文仍按一次正常输入记录
          if (!composing || !tr.docChanged) return true
          if (!/[㐀-鿿]/.test(insertedText(tr))) {
            tr.setMeta('addToHistory', false)
          }
          return true
        }
      }
    })]
  }
})

// 查找高亮：只负责把匹配区间画成装饰，查找状态由 app.js 驱动
export const findHighlightKey = new PluginKey('findHighlight')
export const selectionImageHighlightKey = new PluginKey('selectionImageHighlight')

export const FindHighlight = Extension.create({
  name: 'findHighlight',

  addProseMirrorPlugins () {
    return [new Plugin({
      key: findHighlightKey,
      state: {
        init: () => DecorationSet.empty,
        apply (tr, old) {
          const meta = tr.getMeta(findHighlightKey)
          if (meta) {
            if (!meta.ranges?.length) return DecorationSet.empty
            return DecorationSet.create(tr.doc, meta.ranges.map((range, index) => Decoration.inline(
              range.from,
              range.to,
              { class: index === meta.active ? 'find-match find-match-current' : 'find-match' }
            )))
          }
          if (tr.docChanged) return old.map(tr.mapping, tr.doc)
          return old
        }
      },
      props: {
        decorations (state) {
          return findHighlightKey.getState(state)
        }
      }
    })]
  }
})

// 选区里的图片高亮：img 本身不吃 ::selection，跨图片的 TextSelection
// 只能在这里补一层半透明遮罩，用户才看得出图片也一起被选中（会一起删、一起拖）
export const SelectionImageHighlight = Extension.create({
  name: 'selectionImageHighlight',

  addProseMirrorPlugins () {
    return [new Plugin({
      key: selectionImageHighlightKey,
      props: {
        decorations (state) {
          const selection = state.selection
          // NodeSelection 选单张图时沿用原有的选中框，不再叠遮罩
          if (selection.empty || !(selection instanceof TextSelection)) return null
          const decorations = []
          state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
            if (node.type.name !== 'image') return
            decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: 'in-selection' }))
            return false
          })
          return decorations.length ? DecorationSet.create(state.doc, decorations) : null
        }
      }
    })]
  }
})

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,

  parseHTML () {
    return [{ tag: '[data-page-break]' }, { tag: '.wordlite-page-break' }]
  },

  renderHTML () {
    return ['div', { 'data-page-break': '', class: 'page-break', contenteditable: 'false' }, ['span', '分页符']]
  }
})
