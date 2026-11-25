// 解析 --selftest 输出：CI 里任何一项不满足就失败
// 用法：node tools/ci-selftest.mjs <输出文件>
import { readFileSync } from 'node:fs'

const PREFIX = '[selftest] '
const REQUIRED_BOOL = [
  'bridge', 'tauri', 'editor', 'openedNewWindow', 'blankDragOk', 'contextMenuOk', 'printPreviewRemoved',
  // 页面缩放：控件在、缩放生效、排版像素不变、能回 100%
  'pageZoomControls', 'pageZoomShrinks', 'pageZoomKeepsLayout', 'pageZoomReset',
  // 触控板捏合：预览不写存储、松手落定、有弹窗时忽略
  'pagePinchPreview', 'pagePinchCommits', 'pagePinchIgnoresDialog'
]
const REQUIRED_VALUE = {
  state: 'ok',
  read: 'hello',
  readBinary: 'aGVsbG8=',
  autosave: 'ok'
}

function fail (message) {
  console.error(message)
  process.exit(1)
}

function main () {
  const file = process.argv[2]
  if (!file) {
    fail('用法：node tools/ci-selftest.mjs <selftest 输出文件>')
  }

  let text
  try {
    text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    fail(`读不到自测输出 ${file}：${error.message}`)
  }

  const lines = text.split(/\r?\n/)
  const line = lines.find((item) => item.startsWith(`${PREFIX}{`))
  if (!line) {
    const other = lines.find((item) => item.startsWith(PREFIX))
    fail(other ? `[selftest] 输出异常：${other}` : '输出里没有 [selftest] 行，程序可能没跑起来或超时')
  }

  let results
  try {
    results = JSON.parse(line.slice(PREFIX.length))
  } catch (error) {
    fail(`[selftest] 行不是合法 JSON：${error.message}\n${line}`)
  }

  // 完整结果先打出来，CI 日志里好排查
  console.log(JSON.stringify(results, null, 2))

  const problems = []
  for (const key of REQUIRED_BOOL) {
    if (results[key] !== true) {
      problems.push(`${key} 应为 true，实际 ${JSON.stringify(results[key])}`)
    }
  }
  for (const [key, expected] of Object.entries(REQUIRED_VALUE)) {
    if (results[key] !== expected) {
      problems.push(`${key} 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(results[key])}`)
    }
  }

  if (process.env.REQUIRE_PDF === '1') {
    if (results.pdfHeader !== '%PDF') {
      problems.push(`pdfHeader 应为 "%PDF"，实际 ${JSON.stringify(results.pdfHeader)}`)
    }
    // V2：自定义预览已删除，不再有 previewPages；长文档导出 PDF 至少两页即为分页成功
    if (!(results.longPdfPages >= 2)) {
      problems.push(`longPdfPages 应 ≥ 2，实际 ${JSON.stringify(results.longPdfPages)}`)
    }
  }

  for (const key of ['error', 'longError', 'pdfError', 'openError']) {
    if (results[key]) {
      console.error(`${key}：${results[key]}`)
    }
  }

  if (problems.length) {
    console.error(`自测失败（${problems.length} 项）：`)
    for (const problem of problems) {
      console.error(`- ${problem}`)
    }
    process.exit(1)
  }

  console.log('自测通过')
}

main()
