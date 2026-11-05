#!/usr/bin/env node
// 生成 tools/fixtures/long-mixed.txt：600 段中英数字混排长文档测试样本。
// 用法：node tools/make-long-mixed.mjs
// 不依赖第三方包；随机种子固定，重复运行结果逐字节一致（UTF-8 / LF）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SEED = 20261105
const PARAGRAPH_COUNT = 600
const HAN_MIN = 40
const HAN_MAX = 80
const OUTPUT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'long-mixed.txt')

// mulberry32：确定性伪随机数生成器，避免 Math.random 导致样本每次不同
function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rng = mulberry32(SEED)
const randInt = (min, max) => min + Math.floor(rng() * (max - min + 1))
const pick = (list) => list[randInt(0, list.length - 1)]

// 常用汉字表（脚本自带的字符池，保证结果可复现）
const HAN_POOL = [
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞',
].join('')

// 段内夹带的英文单词与数字/版本号片段
const EN_WORDS = ['WordLite', 'PDF', 'macOS', 'Windows', 'Tauri', 'Rust', 'WebView', 'Markdown', 'CI', 'API', 'JSON', 'CPU']
const NUM_TOKENS = ['2026', '2025', '2024', 'v1.2', 'v0.9', '3.14', '42', '404', '860', '16', '100']

// 生成单段：汉字数 40-80，内部至少夹 1 个英文词和 1 个数字片段
function makeParagraph () {
  const hanCount = randInt(HAN_MIN, HAN_MAX)
  const chars = []
  for (let i = 0; i < hanCount; i += 1) chars.push(HAN_POOL[randInt(0, HAN_POOL.length - 1)])

  const extras = [pick(EN_WORDS), pick(NUM_TOKENS)]
  const extraCount = randInt(2, 4)
  while (extras.length < extraCount) {
    extras.push(rng() < 0.5 ? pick(EN_WORDS) : pick(NUM_TOKENS))
  }

  // 在汉字之间挑不重复的插入点，保持原有汉字数量和顺序
  const slots = new Set()
  while (slots.size < extras.length) slots.add(randInt(0, hanCount - 1))
  const insertAt = [...slots].sort((x, y) => x - y)

  let text = ''
  let extraIndex = 0
  for (let i = 0; i < chars.length; i += 1) {
    if (extraIndex < insertAt.length && insertAt[extraIndex] === i) {
      text += extras[extraIndex]
      extraIndex += 1
    }
    text += chars[i]
  }
  return text
}

function countHan (text) {
  return (text.match(/[\u4e00-\u9fff]/g) || []).length
}

const problems = []

// 先自检生成器自身的字符池，避免把非汉字混进汉字计数
for (const ch of HAN_POOL) {
  if (!/[\u4e00-\u9fff]/.test(ch)) problems.push(`汉字池混入了非汉字字符：${JSON.stringify(ch)}`)
}
if (problems.length === 0) {
  const paragraphs = []
  for (let i = 0; i < PARAGRAPH_COUNT; i += 1) paragraphs.push(makeParagraph())
  const text = paragraphs.join('\n') + '\n'
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, text, 'utf8')

  // 落盘后重新读取做完整自检
  const saved = readFileSync(OUTPUT, 'utf8')
  const lines = saved.endsWith('\n') ? saved.slice(0, -1).split('\n') : saved.split('\n')

  if (saved.includes('\r')) problems.push('文件含 CR，应为纯 LF')
  if (saved.charCodeAt(0) === 0xfeff) problems.push('文件带 BOM，应为无 BOM 的 UTF-8')
  if (!saved.endsWith('\n')) problems.push('文件末尾缺少换行')
  if (saved.endsWith('\n\n')) problems.push('文件末尾多了空行')
  if (Buffer.byteLength(saved, 'utf8') !== Buffer.byteLength(text, 'utf8')) problems.push('写入后字节数不一致')
  if (lines.length !== PARAGRAPH_COUNT) problems.push(`段数应为 ${PARAGRAPH_COUNT}，实际 ${lines.length}`)

  let hanMin = Infinity
  let hanMax = 0
  let mixed = 0
  let lineMin = Infinity
  let lineMax = 0
  lines.forEach((line, index) => {
    const han = countHan(line)
    if (han < HAN_MIN || han > HAN_MAX) {
      problems.push(`第 ${index + 1} 段汉字数应为 ${HAN_MIN}-${HAN_MAX}，实际 ${han}`)
    }
    hanMin = Math.min(hanMin, han)
    hanMax = Math.max(hanMax, han)
    const len = [...line].length
    lineMin = Math.min(lineMin, len)
    lineMax = Math.max(lineMax, len)
    if (/[A-Za-z]/.test(line) && /[0-9]/.test(line)) mixed += 1
  })
  if (mixed !== PARAGRAPH_COUNT) problems.push(`夹带英文和数字的段数应为全部 ${PARAGRAPH_COUNT} 段，实际 ${mixed}`)

  console.log(`已生成 ${OUTPUT}`)
  console.log(`段数：${lines.length}，字节数：${Buffer.byteLength(saved, 'utf8')}`)
  console.log(`汉字数范围：${hanMin}-${hanMax}，行字符数范围：${lineMin}-${lineMax}`)
  console.log(`夹带英文和数字的段数：${mixed}/${lines.length}`)
}

if (problems.length > 0) {
  console.error('自检失败：')
  for (const problem of problems) console.error(`- ${problem}`)
  process.exit(1)
}
console.log('自检通过')
