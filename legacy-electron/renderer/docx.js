// DOCX 导入导出：mammoth 负责读取，docx.js 负责写入
import mammoth from 'mammoth'
import JSZip from 'jszip'
import { generateJSON } from '@tiptap/core'
import {
  AlignmentType,
  BorderStyle,
  convertMillimetersToTwip,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  HighlightColor,
  HorizontalPositionAlign,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LevelFormat,
  Packer,
  PageBreak,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  TextWrappingSide,
  TextWrappingType,
  UnderlineType,
  VerticalPositionAlign,
  VerticalPositionRelativeFrom,
  WidthType
} from 'docx'

export function base64ToBytes (base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function readPageSetup (xmlText) {
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml')
  const sizeElement = xml.getElementsByTagName('w:pgSz')[0]
  const marginElement = xml.getElementsByTagName('w:pgMar')[0]
  if (!sizeElement || !marginElement) return null
  const width = Number(sizeElement.getAttribute('w:w')) / 567
  const height = Number(sizeElement.getAttribute('w:h')) / 567
  const orientation = sizeElement.getAttribute('w:orient') === 'landscape' || width > height ? 'landscape' : 'portrait'
  const normalWidth = orientation === 'landscape' ? height : width
  const normalHeight = orientation === 'landscape' ? width : height
  const sizes = { a4: [21, 29.7], a5: [14.8, 21], letter: [21.59, 27.94] }
  const size = Object.keys(sizes).find((key) => Math.abs(sizes[key][0] - normalWidth) < 0.15 && Math.abs(sizes[key][1] - normalHeight) < 0.15) || 'a4'
  const presets = {
    normal: [2.54, 3.18, 2.54, 3.18],
    narrow: [1.27, 1.27, 1.27, 1.27],
    wide: [2.54, 5.08, 2.54, 5.08]
  }
  const sides = ['top', 'right', 'bottom', 'left']
  const actual = sides.map((side) => Number(marginElement.getAttribute(`w:${side}`)) / 567)
  const margin = Object.keys(presets).find((key) => presets[key].every((value, index) => Math.abs(value - actual[index]) < 0.15)) || 'custom'
  const margins = {}
  sides.forEach((side, index) => {
    margins[side] = Math.round((Number.isFinite(actual[index]) ? actual[index] : presets.normal[index]) * 100) / 100
  })
  const background = xml.getElementsByTagName('w:background')[0]?.getAttribute('w:color')
  return {
    size,
    orientation,
    margin,
    margins,
    background: background ? `#${background.toLowerCase()}` : '#ffffff'
  }
}

const PAGE_BREAK_MARKER = '__WORDLITE_PAGE_BREAK_7F3A__'

function restorePageBreaks (nodes = []) {
  const output = []
  for (const node of nodes) {
    if ((node.type === 'paragraph' || node.type === 'heading') && node.content?.some((child) => child.text?.includes(PAGE_BREAK_MARKER))) {
      let part = { ...node, content: [] }
      for (const child of node.content) {
        if (!child.text?.includes(PAGE_BREAK_MARKER)) {
          part.content.push(child)
          continue
        }
        const pieces = child.text.split(PAGE_BREAK_MARKER)
        pieces.forEach((piece, index) => {
          if (piece) part.content.push({ ...child, text: piece })
          if (index < pieces.length - 1) {
            if (part.content.length) output.push(part)
            output.push({ type: 'pageBreak' })
            part = { ...node, content: [] }
          }
        })
      }
      if (part.content.length) output.push(part)
    } else if (node.content) {
      output.push({ ...node, content: restorePageBreaks(node.content) })
    } else {
      output.push(node)
    }
  }
  return output
}

function directChild (element, name) {
  return Array.from(element?.children || []).find((child) => child.nodeName === name) || null
}

function directChildren (element, name) {
  return Array.from(element?.children || []).filter((child) => child.nodeName === name)
}

function closestTag (element, name) {
  let current = element?.parentNode
  while (current) {
    if (current.nodeName === name) return current
    current = current.parentNode
  }
  return null
}

function hexColor (value, fallback = null) {
  return /^[0-9a-f]{6}$/i.test(value || '') ? `#${value.toLowerCase()}` : fallback
}

function walkJson (node, fn) {
  if (!node) return
  fn(node)
  for (const child of node.content || []) walkJson(child, fn)
}

function paragraphStylesFromXml (xml) {
  const map = new Map()
  for (const paragraph of Array.from(xml.getElementsByTagName('w:p'))) {
    const text = Array.from(paragraph.getElementsByTagName('w:t')).map((node) => node.textContent || '').join('')
    if (!text) continue
    const pPr = directChild(paragraph, 'w:pPr')
    const spacing = directChild(pPr, 'w:spacing')
    const style = {}
    if (spacing) {
      const before = Number.parseFloat(spacing.getAttribute('w:before'))
      const after = Number.parseFloat(spacing.getAttribute('w:after'))
      const line = Number.parseFloat(spacing.getAttribute('w:line'))
      if (Number.isFinite(before)) style.spacingBefore = Math.round(before / 20 * 10) / 10
      if (Number.isFinite(after)) style.spacingAfter = Math.round(after / 20 * 10) / 10
      if (Number.isFinite(line) && line > 0) style.lineHeight = Math.round(line / 240 * 100) / 100
    }
    const runSpacings = []
    for (const run of Array.from(paragraph.getElementsByTagName('w:r'))) {
      const runText = Array.from(run.getElementsByTagName('w:t')).map((node) => node.textContent || '').join('')
      if (!runText) continue
      const runSpacing = directChild(directChild(run, 'w:rPr'), 'w:spacing')
      const value = Number.parseFloat(runSpacing?.getAttribute('w:val'))
      if (Number.isFinite(value) && value !== 0) {
        runSpacings.push({ text: runText, letterSpacing: Math.round(value / 20 * 10) / 10 })
      }
    }
    if (runSpacings.length) style.runSpacings = runSpacings
    if (!Object.keys(style).length) continue
    if (!map.has(text)) map.set(text, [])
    map.get(text).push(style)
  }
  return map
}

function applyRunLetterSpacing (node, runSpacings) {
  const queues = new Map()
  for (const run of runSpacings) {
    if (!queues.has(run.text)) queues.set(run.text, [])
    queues.get(run.text).push(run.letterSpacing)
  }
  node.content = (node.content || []).map((child) => {
    if (child.type !== 'text' || !child.text) return child
    const queue = queues.get(child.text)
    if (!queue?.length) return child
    const letterSpacing = queue.shift()
    const marks = (child.marks || []).filter((mark) => mark.type !== 'textStyle')
    const old = (child.marks || []).find((mark) => mark.type === 'textStyle')
    marks.push({ type: 'textStyle', attrs: { ...(old?.attrs || {}), letterSpacing } })
    return { ...child, marks }
  })
}

function applyParagraphStyles (json, xml) {
  const styles = paragraphStylesFromXml(xml)
  if (!styles.size) return
  walkJson(json, (node) => {
    if (!['paragraph', 'heading'].includes(node.type)) return
    const text = (node.content || []).map((child) => child.type === 'text' ? child.text || '' : '').join('')
    const queue = styles.get(text)
    if (!queue?.length) return
    const style = queue.shift()
    node.attrs = { ...(node.attrs || {}) }
    if (style.spacingBefore !== undefined) node.attrs.spacingBefore = style.spacingBefore
    if (style.spacingAfter !== undefined) node.attrs.spacingAfter = style.spacingAfter
    if (style.lineHeight !== undefined) node.attrs.lineHeight = style.lineHeight
    if (style.runSpacings?.length) applyRunLetterSpacing(node, style.runSpacings)
  })
}

function imageStylesFromXml (xml) {
  const styles = []
  for (const drawing of Array.from(xml.getElementsByTagName('w:drawing'))) {
    const extent = drawing.getElementsByTagName('wp:extent')[0]
    if (!extent) continue
    const width = Math.max(0, Math.round(Number(extent.getAttribute('cx')) / 9525))
    const height = Math.max(0, Math.round(Number(extent.getAttribute('cy')) / 9525))
    const cropElement = drawing.getElementsByTagName('a:srcRect')[0]
    const crop = {
      top: Number(cropElement?.getAttribute('t')) / 1000 || 0,
      right: Number(cropElement?.getAttribute('r')) / 1000 || 0,
      bottom: Number(cropElement?.getAttribute('b')) / 1000 || 0,
      left: Number(cropElement?.getAttribute('l')) / 1000 || 0
    }
    const anchor = drawing.getElementsByTagName('wp:anchor')[0]
    const paragraph = closestTag(drawing, 'w:p')
    const jc = directChild(directChild(paragraph, 'w:pPr'), 'w:jc')?.getAttribute('w:val')
    const positionH = anchor?.getElementsByTagName('wp:positionH')[0]
    const align = positionH?.getElementsByTagName('wp:align')[0]?.textContent
    const hasWrap = ['wp:wrapSquare', 'wp:wrapTight', 'wp:wrapThrough']
      .some((name) => drawing.getElementsByTagName(name).length > 0)
    const style = {
      width: width || null,
      height: height || null,
      crop
    }
    if (anchor) {
      if (hasWrap && ['left', 'right'].includes(align)) style.wrap = align
      if (['center', 'right'].includes(jc)) style.align = jc
      else if (!hasWrap && ['center', 'right'].includes(align)) style.align = align
    } else if (['center', 'right'].includes(jc)) {
      style.align = jc
    }
    styles.push(style)
  }
  return styles
}

function applyImageStyles (json, xml) {
  const styles = imageStylesFromXml(xml)
  if (!styles.length) return
  let index = 0
  walkJson(json, (node) => {
    if (node.type !== 'image' || index >= styles.length) return
    node.attrs = { ...(node.attrs || {}), ...styles[index++] }
  })
}

function tableStylesFromXml (xml) {
  const styles = []
  for (const tbl of Array.from(xml.getElementsByTagName('w:tbl'))) {
    const grid = directChildren(directChild(tbl, 'w:tblGrid'), 'w:gridCol')
      .map((col) => Number(col.getAttribute('w:w')))
      .filter((value) => Number.isFinite(value) && value > 0)
    const borderElement = directChild(directChild(tbl, 'w:tblPr'), 'w:tblBorders')
    const borderSample = borderElement && (directChild(borderElement, 'w:top') || directChild(borderElement, 'w:insideV'))
    let borderSize
    let borderColor
    if (borderSample) {
      const value = borderSample.getAttribute('w:val')
      if (['nil', 'none'].includes(value)) {
        borderSize = 0
      } else {
        borderSize = Math.round((Number(borderSample.getAttribute('w:sz')) || 4) / 8 * 100) / 100
        borderColor = hexColor(borderSample.getAttribute('w:color'), '#000000')
      }
    }
    const rows = []
    for (const row of directChildren(tbl, 'w:tr')) {
      const cells = []
      let column = 0
      for (const cell of directChildren(row, 'w:tc')) {
        const span = Math.max(1, Number(directChild(directChild(cell, 'w:tcPr'), 'w:gridSpan')?.getAttribute('w:val')) || 1)
        const vMerge = directChild(directChild(cell, 'w:tcPr'), 'w:vMerge')
        const isContinuation = vMerge && vMerge.getAttribute('w:val') !== 'restart'
        const widths = grid.slice(column, column + span)
        column += span
        if (isContinuation) continue
        const fill = directChild(directChild(cell, 'w:tcPr'), 'w:shd')?.getAttribute('w:fill')
        const background = /^[0-9a-f]{6}$/i.test(fill || '') && !/^ffffff$/i.test(fill)
          ? `#${fill.toLowerCase()}`
          : null
        cells.push({
          background,
          colwidth: widths.length === span ? widths.map((value) => Math.round(value / 15)) : null
        })
      }
      rows.push(cells)
    }
    styles.push({ borderSize, borderColor, rows })
  }
  return styles
}

function applyTableStyles (json, xml) {
  const styles = tableStylesFromXml(xml)
  if (!styles.length) return
  let index = 0
  walkJson(json, (node) => {
    if (node.type !== 'table' || index >= styles.length) return
    const style = styles[index++]
    node.attrs = { ...(node.attrs || {}) }
    if (style.borderSize !== undefined) node.attrs.borderSize = style.borderSize
    if (style.borderColor) node.attrs.borderColor = style.borderColor
    for (const [rowIndex, row] of (node.content || []).entries()) {
      const sourceCells = style.rows[rowIndex] || []
      for (const [cellIndex, cell] of (row.content || []).entries()) {
        const source = sourceCells[cellIndex]
        if (!source) continue
        cell.attrs = { ...(cell.attrs || {}) }
        if (source.background) cell.attrs.background = source.background
        if (source.colwidth) cell.attrs.colwidth = source.colwidth
      }
    }
  })
}

export async function docxBase64ToJSON (base64, extensions) {
  const zip = await JSZip.loadAsync(base64ToBytes(base64))
  const file = zip.file('word/document.xml')
  const xml = file ? await file.async('string') : ''
  if (file) {
    const marked = xml
      .replace(/<w:br\b(?=[^>]*\bw:type="page")[^>]*\/>/g, `<w:t>${PAGE_BREAK_MARKER}</w:t>`)
      .replace(/<w:br\b(?=[^>]*\bw:type="page")[^>]*><\/w:br>/g, `<w:t>${PAGE_BREAK_MARKER}</w:t>`)
    zip.file('word/document.xml', marked)
  }
  const converted = await zip.generateAsync({ type: 'uint8array' })
  const result = await mammoth.convertToHtml({ arrayBuffer: converted.buffer })
  const json = generateJSON(result.value, extensions)
  if (xml) {
    const xmlDocument = new DOMParser().parseFromString(xml, 'application/xml')
    applyParagraphStyles(json, xmlDocument)
    applyImageStyles(json, xmlDocument)
    applyTableStyles(json, xmlDocument)
  }
  json.content = restorePageBreaks(json.content)
  return {
    json,
    pageSetup: xml ? readPageSetup(xml) : null,
    warnings: result.messages.map((message) => message.message)
  }
}

const hasMark = (node, name) => !!node.marks?.some((mark) => mark.type === name)
const getMark = (node, name) => node.marks?.find((mark) => mark.type === name)

const HIGHLIGHTS = {
  '#ffff00': HighlightColor.YELLOW,
  '#00ff00': HighlightColor.GREEN,
  '#00ffff': HighlightColor.CYAN,
  '#ff00ff': HighlightColor.MAGENTA,
  '#0000ff': HighlightColor.BLUE,
  '#ff0000': HighlightColor.RED,
  '#000080': HighlightColor.DARK_BLUE,
  '#008000': HighlightColor.DARK_GREEN
}

function runOptions (node) {
  const textStyle = getMark(node, 'textStyle')?.attrs || {}
  const highlight = getMark(node, 'highlight')
  const fontSize = Number.parseFloat(textStyle.fontSize)
  const letterSpacing = Number.parseFloat(textStyle.letterSpacing)
  const options = {
    text: node.text || '',
    bold: hasMark(node, 'bold') || undefined,
    italics: hasMark(node, 'italic') || undefined,
    strike: hasMark(node, 'strike') || undefined,
    underline: hasMark(node, 'underline') ? { type: UnderlineType.SINGLE } : undefined,
    color: textStyle.color ? textStyle.color.replace(/^#/, '') : undefined,
    highlight: highlight ? HIGHLIGHTS[highlight.attrs?.color] || HighlightColor.YELLOW : undefined,
    font: textStyle.fontFamily ? textStyle.fontFamily.split(',')[0].replace(/["']/g, '') : undefined,
    size: Number.isFinite(fontSize) ? Math.round(fontSize * 2) : undefined,
    characterSpacing: Number.isFinite(letterSpacing) ? Math.round(letterSpacing * 20) : undefined,
    superScript: hasMark(node, 'superscript') || undefined,
    subScript: hasMark(node, 'subscript') || undefined
  }
  if (hasMark(node, 'code')) options.font = 'Consolas'
  return options
}

function imageInfo (src) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const scale = Math.min(1, 600 / (image.naturalWidth || 600))
      resolve({
        width: Math.max(1, Math.round((image.naturalWidth || 600) * scale)),
        height: Math.max(1, Math.round((image.naturalHeight || 400) * scale))
      })
    }
    image.onerror = () => resolve({ width: 480, height: 270 })
    image.src = src
  })
}

function cropValue (crop, side) {
  return Math.max(0, Math.min(95, Number(crop?.[side]) || 0))
}

async function imageRun (node) {
  const attrs = node.attrs || {}
  const src = attrs.src || ''
  const match = src.match(/^data:(image\/(?:png|jpeg|jpg|gif|bmp));base64,(.+)$/i)
  if (!match) return new TextRun({ text: attrs.alt || '[图片]' })
  const type = match[1].toLowerCase() === 'image/jpeg' ? 'jpg' : match[1].slice(6).toLowerCase()
  const natural = await imageInfo(src)
  const crop = {
    top: cropValue(attrs.crop, 'top'),
    right: cropValue(attrs.crop, 'right'),
    bottom: cropValue(attrs.crop, 'bottom'),
    left: cropValue(attrs.crop, 'left')
  }
  const hasCrop = crop.top || crop.right || crop.bottom || crop.left
  const visibleWidth = natural.width * (1 - (crop.left + crop.right) / 100)
  const visibleHeight = natural.height * (1 - (crop.top + crop.bottom) / 100)
  let width = Number(attrs.width) || visibleWidth
  let height = Number(attrs.height) || (width * visibleHeight / Math.max(1, visibleWidth))
  if (!Number(attrs.width) && width > 600) {
    const scale = 600 / width
    width *= scale
    height *= scale
  }
  width = Math.max(1, Math.round(width))
  height = Math.max(1, Math.round(height))
  const floating = ['left', 'right'].includes(attrs.wrap)
    ? {
        horizontalPosition: {
          relative: HorizontalPositionRelativeFrom.COLUMN,
          align: attrs.wrap === 'left' ? HorizontalPositionAlign.LEFT : HorizontalPositionAlign.RIGHT
        },
        verticalPosition: {
          relative: VerticalPositionRelativeFrom.PARAGRAPH,
          align: VerticalPositionAlign.TOP
        },
        wrap: { type: TextWrappingType.SQUARE, side: TextWrappingSide.BOTH_SIDES }
      }
    : undefined
  return new ImageRun({
    data: base64ToBytes(match[2]),
    transformation: { width, height },
    type,
    crop: hasCrop ? crop : undefined,
    floating,
    altText: {
      title: attrs.title || attrs.alt || '图片',
      description: attrs.alt || '图片',
      name: '图片'
    }
  })
}

async function inlineRuns (nodes = []) {
  const runs = []
  for (const node of nodes) {
    if (node.type === 'text') {
      const options = runOptions(node)
      const link = getMark(node, 'link')
      if (link?.attrs?.href) {
        runs.push(new ExternalHyperlink({
          children: [new TextRun({ ...options, style: 'Hyperlink' })],
          link: link.attrs.href
        }))
      } else {
        runs.push(new TextRun(options))
      }
    } else if (node.type === 'hardBreak') {
      runs.push(new TextRun({ text: '', break: 1 }))
    } else if (node.type === 'image') {
      runs.push(await imageRun(node))
    }
  }
  return runs
}

const ALIGNMENTS = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
}

const HEADINGS = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3
}

async function paragraph (node, context = {}, leadingRuns = []) {
  const attrs = node.attrs || {}
  const lineHeight = Number.parseFloat(attrs.lineHeight)
  const spacing = {}
  if (Number.isFinite(lineHeight)) spacing.line = Math.round(lineHeight * 240)
  if (Number.isFinite(attrs.spacingBefore)) spacing.before = Math.round(attrs.spacingBefore * 20)
  if (Number.isFinite(attrs.spacingAfter)) spacing.after = Math.round(attrs.spacingAfter * 20)
  const image = node.content?.find((child) => child.type === 'image')
  const options = {
    children: [...leadingRuns, ...(await inlineRuns(node.content))],
    alignment: ALIGNMENTS[image?.attrs?.align || attrs.textAlign],
    heading: HEADINGS[attrs.level],
    spacing: Object.keys(spacing).length ? spacing : undefined,
    indent: attrs.indent ? { left: attrs.indent * 480 } : context.blockquote ? { left: 420 } : undefined
  }
  if (context.listType === 'bullet') options.bullet = { level: context.listLevel || 0 }
  if (context.listType === 'ordered') {
    options.numbering = { reference: 'wordlite-numbering', level: context.listLevel || 0 }
    if (context.listInstance) options.numbering.instance = context.listInstance
  }
  if (context.codeBlock) options.children = [new TextRun({ text: node.text || '', font: 'Consolas' })]
  return new Paragraph(options)
}

function tableGridWidths (node) {
  const grid = []
  for (const row of node.content || []) {
    let column = 0
    for (const cell of row.content || []) {
      const attrs = cell.attrs || {}
      const span = Math.max(1, Number(attrs.colspan) || 1)
      const widths = Array.isArray(attrs.colwidth) ? attrs.colwidth : null
      if (widths?.length) {
        for (let index = 0; index < span; index++) {
          const width = Number(widths[index] ?? widths[0])
          if (Number.isFinite(width) && width > 0 && !grid[column + index]) grid[column + index] = Math.round(width * 15)
        }
      }
      column += span
    }
  }
  return grid.length && grid.every(Boolean) ? grid : null
}

function tableCellWidth (attrs) {
  const widths = Array.isArray(attrs.colwidth) ? attrs.colwidth.filter((value) => Number.isFinite(Number(value))) : []
  if (!widths.length) return undefined
  return { size: Math.max(1, Math.round(widths.reduce((sum, value) => sum + Number(value), 0) * 15)), type: WidthType.DXA }
}

async function table (node, context = {}) {
  const rows = []
  const tableAttrs = node.attrs || {}
  for (const row of node.content || []) {
    const cells = []
    for (const cell of row.content || []) {
      const children = await blocks(cell.content || [], { listCounter: context.listCounter })
      const attrs = cell.attrs || {}
      const columnSpan = Math.min(63, Math.max(1, Number(attrs.colspan) || 1))
      const rowSpan = Math.min(63, Math.max(1, Number(attrs.rowspan) || 1))
      const background = /^#[0-9a-f]{6}$/i.test(attrs.background || '') ? attrs.background.slice(1).toUpperCase() : undefined
      cells.push(new TableCell({
        children: children.length ? children : [new Paragraph('')],
        columnSpan: columnSpan > 1 ? columnSpan : undefined,
        rowSpan: rowSpan > 1 ? rowSpan : undefined,
        width: tableCellWidth(attrs),
        shading: background ? { fill: background } : undefined
      }))
    }
    rows.push(new TableRow({ children: cells }))
  }
  const sizePt = Math.max(0, Number(tableAttrs.borderSize) || 0)
  const color = /^#[0-9a-f]{6}$/i.test(tableAttrs.borderColor || '') ? tableAttrs.borderColor.slice(1).toUpperCase() : 'BFBFBF'
  const border = sizePt > 0
    ? { style: BorderStyle.SINGLE, size: Math.max(2, Math.min(96, Math.round(sizePt * 8))), color }
    : { style: BorderStyle.NONE, size: 0, color: 'auto' }
  const columnWidths = tableGridWidths(node)
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: columnWidths || undefined,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border }
  })
}

async function blocks (nodes = [], context = {}) {
  const output = []
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]
    if (node.type === 'paragraph' || node.type === 'heading') {
      output.push(await paragraph(node, context))
    } else if (node.type === 'codeBlock') {
      const text = (node.content || []).map((child) => child.text || '').join('')
      for (const line of text.split('\n')) output.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Consolas' })] }))
    } else if (node.type === 'blockquote') {
      output.push(...await blocks(node.content, { ...context, blockquote: true }))
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      const listType = node.type === 'bulletList' ? 'bullet' : 'ordered'
      const listLevel = Math.min(8, context.inList ? (context.listLevel || 0) + 1 : 0)
      const listInstance = listType === 'ordered' && context.listCounter ? ++context.listCounter.value : undefined
      for (const item of node.content || []) {
        output.push(...await blocks(item.content || [], { ...context, inList: true, listType, listLevel, listInstance }))
      }
    } else if (node.type === 'pageBreak') {
      output.push(new Paragraph({ children: [new PageBreak()] }))
    } else if (node.type === 'horizontalRule') {
      output.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'A6A6A6', space: 1 } } }))
    } else if (node.type === 'table') {
      output.push(await table(node, context))
    } else if (node.type === 'image') {
      const next = nodes[index + 1]
      const floating = ['left', 'right'].includes(node.attrs?.wrap)
      const nextHasText = (next?.content || []).some((child) => child.type !== 'hardBreak' && String(child.text || '').trim())
      // 浮动图片和后面的正文放进同一段，Word/WPS 才会在锚点所在段落内左右绕排
      if (floating && nextHasText && (next?.type === 'paragraph' || next?.type === 'heading')) {
        output.push(await paragraph(next, context, [await imageRun(node)]))
        index++
      } else {
        output.push(new Paragraph({
          children: [await imageRun(node)],
          alignment: ALIGNMENTS[node.attrs?.align]
        }))
      }
    }
  }
  return output
}

export async function jsonToDocxBase64 (json, pageSetup = {}, defaults = {}) {
  const setup = { size: 'a4', orientation: 'portrait', margin: 'normal', background: '#ffffff', ...pageSetup }
  const sizes = { a4: [21, 29.7], a5: [14.8, 21], letter: [21.59, 27.94] }
  const marginPresets = {
    normal: { top: 2.54, right: 3.18, bottom: 2.54, left: 3.18 },
    narrow: { top: 1.27, right: 1.27, bottom: 1.27, left: 1.27 },
    wide: { top: 2.54, right: 5.08, bottom: 2.54, left: 5.08 }
  }
  const baseSize = sizes[setup.size] || sizes.a4
  const width = baseSize[0]
  const height = baseSize[1]
  const margin = setup.margins || marginPresets[setup.margin] || marginPresets.normal
  const toTwip = (cm) => convertMillimetersToTwip(Number(cm) * 10)
  const defaultFont = String(defaults.fontFamily || 'DengXian, 等线').split(',')[0].replace(/["']/g, '').trim() || 'DengXian'
  const defaultFontSize = Math.max(2, Math.round((Number(defaults.fontSize) || 11) * 2))
  const defaultLineHeight = Math.max(1, Number(defaults.lineHeight) || 1.6)
  const children = await blocks(json.content || [], { listCounter: { value: 0 } })
  const levels = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: AlignmentType.START,
    style: { paragraph: { indent: { left: (level + 1) * 720, hanging: 360 } } }
  }))
  const document = new Document({
    creator: '简写 WordLite',
    title: '简写文档',
    description: '由简写 WordLite 生成',
    background: { color: setup.background.replace(/^#/, '').toUpperCase() },
    styles: {
      default: {
        document: {
          run: { font: defaultFont, size: defaultFontSize, color: '1A1A1A' },
          paragraph: { spacing: { line: Math.round(defaultLineHeight * 240), after: 48 } }
        }
      }
    },
    numbering: {
      config: [{ reference: 'wordlite-numbering', levels }]
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: toTwip(width),
            height: toTwip(height),
            orientation: setup.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
          },
          margin: {
            top: toTwip(margin.top),
            right: toTwip(margin.right),
            bottom: toTwip(margin.bottom),
            left: toTwip(margin.left)
          }
        }
      },
      children: children.length ? children : [new Paragraph('')]
    }]
  })
  return Packer.toBase64String(document)
}
