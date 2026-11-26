// 屏幕分页：把连续文档按 A4 纸高切成多页，页与页之间留缝。
//
// 做法：正文仍然是同一个 ProseMirror 文档（不分页节点、不改模型），
// 用 widget decoration 在跨页行首插一个块级空 span，把后面的内容顶到下一页。
// 页层只负责画纸、阴影和页码，双击页缝可以把空白收起/展开。
// 打印时页层和 widget 全部隐藏，走浏览器自己的分页。
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const PAGE_GAP_DEFAULT = 16
export const paginationKey = new PluginKey('wordlitePagination')

const EPS = 0.5
const MAX_PAGES = 5000
const TEXT_BLOCKS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE'])

export const Pagination = Extension.create({
  name: 'wordlitePagination',
  addProseMirrorPlugins () {
    return [new Plugin({
      key: paginationKey,
      state: {
        init: () => DecorationSet.empty,
        apply (tr, old) {
          const meta = tr.getMeta(paginationKey)
          if (meta) return meta.decorations
          // 文档变化时让装饰跟着位置走，避免重排前的这一拍错位
          return old.map(tr.mapping, tr.doc)
        }
      },
      props: {
        decorations (state) { return paginationKey.getState(state) }
      }
    })]
  }
})

// 把正文里的块摊平成可排的“行”和“不可拆块”。
// 文本块按行算，图片段落/表格/水平线/手动分页符整块算。
function collectBlocks (root) {
  const blocks = []
  const walk = (parent) => {
    for (const el of parent.children) {
      const tag = el.tagName
      if (tag === 'TABLE') {
        blocks.push({ el, atomic: true })
        continue
      }
      if (tag === 'HR') {
        blocks.push({ el, atomic: true })
        continue
      }
      if (el.classList.contains('page-break')) {
        blocks.push({ el, atomic: true, pageBreak: true })
        continue
      }
      if (TEXT_BLOCKS.has(tag)) {
        // 有图（含缩放容器）的段落不拆行：图片按整段跟着走
        const atomic = !!el.querySelector('img, [data-resize-container]')
        blocks.push({ el, atomic })
        continue
      }
      // 列表、引用、列表项、表格包装层等容器继续往里找
      walk(el)
    }
  }
  walk(root)
  return blocks
}

// 一个文本块里有多少个视觉行：只取文字节点的矩形，避免把块本身那一整块也算成一行。
// 空段落没有文字矩形，返回 0，由调用方按整块一行处理。
function textLineGroups (el) {
  const range = document.createRange()
  const rects = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    if (!node.nodeValue) continue
    range.selectNodeContents(node)
    for (const rect of range.getClientRects()) {
      if (rect.width > 0.5 && rect.height > 0.5) rects.push(rect)
    }
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left)
  const groups = []
  for (const rect of rects) {
    const last = groups[groups.length - 1]
    const overlap = last
      ? Math.min(last.bottom, rect.bottom) - Math.max(last.top, rect.top)
      : 0
    if (last && overlap > Math.min(last.height, rect.height) * 0.5) {
      last.top = Math.min(last.top, rect.top)
      last.bottom = Math.max(last.bottom, rect.bottom)
      last.height = last.bottom - last.top
      last.left = Math.min(last.left, rect.left)
      last.cy = (last.top + last.bottom) / 2
    } else {
      groups.push({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        height: rect.height,
        cy: (rect.top + rect.bottom) / 2
      })
    }
  }
  return groups
}

// 块的位置按“父节点第几个孩子”来取，比 posAtDOM(el, 0) - 1 稳：
// 原子块（分页符、分割线）的 posAtDOM(el, 0) 本身就是节点前面的位置，再减一就跑到上一段里了。
// 表格外面还套着一层 .tableWrapper（不是文档节点），要跨过它再取位置，
// 否则会落到表格内部，间隔就把整张表撑高了。
function blockParentIndex (el) {
  let node = el
  let parent = node.parentNode
  while (parent && parent.nodeType === Node.ELEMENT_NODE && parent.classList.contains('tableWrapper')) {
    node = parent
    parent = parent.parentNode
  }
  return { parent, index: Array.prototype.indexOf.call(parent.children, node) }
}

function posBeforeBlock (view, el) {
  try {
    const { parent, index } = blockParentIndex(el)
    return view.posAtDOM(parent, index)
  } catch {
    return 0
  }
}

function posAfterBlock (view, el) {
  try {
    const { parent, index } = blockParentIndex(el)
    return view.posAtDOM(parent, index + 1)
  } catch {
    return posBeforeBlock(view, el) + 1
  }
}

function lineStartPos (view, el, lineIndex, spacing, top, paperTop, scale) {
  if (lineIndex <= 0) return posBeforeBlock(view, el)
  const rect = el.getBoundingClientRect()
  // top 是纸面排版坐标（未缩放）；换算成当前屏幕坐标再问 ProseMirror
  const clientY = paperTop + (top + spacing / 2) * scale
  const hit = view.posAtCoords({ left: rect.left + 2, top: clientY })
  if (hit && Number.isFinite(hit.pos)) return hit.pos
  return posBeforeBlock(view, el)
}

function setDecorations (view, breaks) {
  const decorations = []
  for (const item of breaks) {
    const dom = document.createElement('span')
    dom.className = 'page-gap-widget'
    dom.contentEditable = 'false'
    dom.setAttribute('aria-hidden', 'true')
    dom.style.height = `${Math.max(0, item.height).toFixed(2)}px`
    decorations.push(Decoration.widget(item.pos, dom, { side: -1 }))
  }
  const set = DecorationSet.create(view.state.doc, decorations)
  view.dispatch(view.state.tr.setMeta(paginationKey, { decorations: set }))
}

export function createPaginator ({
  editor,
  getGeometry,
  getGap,
  getScale = () => 1,
  onPageUpdate = null,
  shouldDefer = null,
  scheduleDelay = 180
}) {
  const paper = editor.view.dom.closest('.paper')
  const layer = paper?.querySelector('.page-layer') || null
  let timer = 0
  let running = false
  let pageCount = 1
  let bands = []
  let lastBreaks = []
  let lastItems = []

  function schedule (delay = scheduleDelay) {
    clearTimeout(timer)
    timer = setTimeout(runNow, delay)
  }

  function clearDecorations () {
    const current = paginationKey.getState(editor.state)
    if (current && current !== DecorationSet.empty) {
      editor.view.dispatch(editor.state.tr.setMeta(paginationKey, { decorations: DecorationSet.empty }))
    }
  }

  // 第一次编排：在干净布局上量每一行，算出每页断在哪
  function computeBreaks (geom, scale) {
    const paperRect = paper.getBoundingClientRect()
    const paperTop = paperRect.top
    const blocks = collectBlocks(editor.view.dom)
    const items = []
    for (const block of blocks) {
      const rect = block.el.getBoundingClientRect()
      const top = (rect.top - paperTop) / scale
      const height = rect.height / scale
      if (block.atomic) {
        items.push({
          kind: 'atomic',
          el: block.el,
          pageBreak: !!block.pageBreak,
          top,
          height,
          lineIndex: 0,
          spacing: height,
          lineCount: 1
        })
        continue
      }
      const groups = textLineGroups(block.el)
      const count = Math.max(1, groups.length)
      const spacing = height / count
      for (let i = 0; i < count; i += 1) {
        items.push({
          kind: 'line',
          el: block.el,
          top: top + i * spacing,
          height: spacing,
          lineIndex: i,
          spacing,
          lineCount: count
        })
      }
    }

    const pageTop = (page) => page * (geom.pageHeight + geom.gap)
    const contentTop = (page) => pageTop(page) + geom.marginTop
    const contentBottom = (page) => pageTop(page) + geom.pageHeight - geom.marginBottom
    const breaks = []
    let shift = 0
    let page = 0
    let forceAfter = null

    for (const item of items) {
      let top = item.top + shift
      let bottom = top + item.height

      // 手动分页符：先保证它自己不被挤到下一页（那会多出空白页），
      // 再把后面的内容整体推到下一页正文顶
      if (forceAfter !== null) {
        const target = contentTop(page + 1)
        const delta = target - top
        if (delta > EPS) {
          breaks.push({
            pos: forceAfter,
            height: delta,
            target,
            el: item.el,
            lineIndex: item.lineIndex,
            boundary: item.lineIndex === 0 || item.kind === 'atomic'
          })
          shift += delta
          page += 1
          top += delta
          bottom += delta
        }
        forceAfter = null
      }

      if (!item.pageBreak && bottom > contentBottom(page) + EPS) {
        if (item.height > geom.contentHeight + EPS) {
          // 单块比一页还高（超高表格/图片）：不拆，溢出并跳过它占的页
          while (bottom > contentBottom(page) + EPS && page < MAX_PAGES) page += 1
        } else {
          const target = contentTop(page + 1)
          const delta = target - top
          if (delta > EPS) {
            const pos = lineStartPos(
              editor.view,
              item.el,
              item.lineIndex,
              item.spacing,
              item.top,
              paperTop,
              scale
            )
            breaks.push({
              pos,
              height: delta,
              target,
              el: item.el,
              lineIndex: item.lineIndex,
              boundary: item.lineIndex === 0 || item.kind === 'atomic'
            })
            shift += delta
            page += 1
            top += delta
            bottom += delta
          }
        }
      }

      if (item.pageBreak) {
        forceAfter = posAfterBlock(editor.view, item.el)
      }
    }

    lastItems = items
    return { breaks, pageCount: page + 1, paperTop }
  }

  // 落点校正：块边界会有外边距打架，行内断点会有缩放/亚像素误差。
  // 行内断点看它自己那个间隔 widget 的下沿——那正是下一行的行框顶，比量字形更稳。
  // 按顺序量每个断点实际落在哪，用累计误差算各间隔该补多少。
  function correctBreaks (breaks, paperTop, scale) {
    if (!breaks.length) return false
    const widgets = Array.from(editor.view.dom.querySelectorAll('.page-gap-widget'))
    let prevError = 0
    let changed = false
    for (let i = 0; i < breaks.length; i += 1) {
      const item = breaks[i]
      let actual = null
      if (item.boundary) {
        actual = (item.el.getBoundingClientRect().top - paperTop) / scale
      } else if (widgets[i]) {
        actual = (widgets[i].getBoundingClientRect().bottom - paperTop) / scale
      }
      if (actual == null) continue
      const error = actual - item.target
      const adjust = -(error - prevError)
      prevError = error
      if (Math.abs(adjust) > 0.3) {
        item.height = Math.max(0, item.height + adjust)
        changed = true
      }
    }
    return changed
  }

  function renderPages (geom, computedPages) {
    if (!layer) return
    const scale = getScale() || 1
    const contentHeight = editor.view.dom.getBoundingClientRect().height / scale
    const total = geom.marginTop + contentHeight + geom.marginBottom
    const byHeight = Math.ceil((total + geom.gap - 0.5) / (geom.pageHeight + geom.gap))
    pageCount = Math.max(1, computedPages, byHeight)
    const totalHeight = pageCount * geom.pageHeight + (pageCount - 1) * geom.gap
    paper.style.minHeight = `${totalHeight.toFixed(2)}px`

    const sheets = []
    for (let i = 0; i < pageCount; i += 1) {
      const sheet = document.createElement('div')
      sheet.className = 'page-sheet'
      sheet.style.top = `${(i * (geom.pageHeight + geom.gap)).toFixed(2)}px`
      sheet.style.height = `${geom.pageHeight.toFixed(2)}px`
      if (geom.background) sheet.style.background = geom.background
      const number = document.createElement('span')
      number.className = 'page-sheet-number'
      number.textContent = String(i + 1)
      sheet.appendChild(number)
      sheets.push(sheet)
    }
    layer.replaceChildren(...sheets)
  }

  function runNow () {
    if (!paper) return
    if (shouldDefer && shouldDefer()) return
    if (editor.view.composing) {
      schedule(320)
      return
    }
    if (running) return
    running = true
    try {
      const scale = getScale() || 1
      const geom = { ...getGeometry(), gap: getGap() }

      // 关键：清空旧间隔、量、再一次性写回，全部在同一个任务里完成。
      // 中间不让浏览器绘制，所以看不到闪动。
      clearDecorations()
      paper.getBoundingClientRect()

      const first = computeBreaks(geom, scale)
      let breaks = first.breaks
      lastBreaks = breaks
      setDecorations(editor.view, breaks)
      paper.getBoundingClientRect()

      // 落点误差校正，最多两轮
      for (let i = 0; i < 2; i += 1) {
        if (!correctBreaks(breaks, first.paperTop, scale)) break
        setDecorations(editor.view, breaks)
        paper.getBoundingClientRect()
      }

      bands = breaks.map((item) => ({
        top: item.target - item.height,
        bottom: item.target
      }))
      renderPages(geom, first.pageCount)
      paper.classList.add('paginated')
      if (onPageUpdate) onPageUpdate({ pageCount, bands })
    } finally {
      running = false
    }
  }

  function force (delay = 0) {
    schedule(delay)
  }

  return {
    schedule,
    force,
    runNow,
    gapBands: () => bands,
    getPageCount: () => pageCount,
    debug: () => ({
      pageCount,
      breaks: lastBreaks.map((item) => ({
        pos: item.pos,
        height: item.height,
        target: item.target,
        boundary: item.boundary,
        tag: item.el?.tagName,
        cls: item.el?.className || ''
      })),
      items: lastItems.map((item) => ({
        kind: item.kind,
        pageBreak: !!item.pageBreak,
        tag: item.el?.tagName,
        cls: item.el?.className || '',
        top: item.top,
        height: item.height,
        lineIndex: item.lineIndex,
        lineCount: item.lineCount
      }))
    }),
    destroy () {
      clearTimeout(timer)
      if (paper) paper.classList.remove('paginated')
      clearDecorations()
    }
  }
}
