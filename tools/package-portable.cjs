// 生成免安装便携版：dist/WordLite/WordLite.exe + 同目录 zip
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const distRoot = path.join(root, 'dist')
const preferredOutDir = path.join(distRoot, 'WordLite')
let outDir = preferredOutDir
let zipPath = path.join(distRoot, `WordLite-${pkg.version}-portable.zip`)
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const electronDist = path.join(root, 'node_modules', 'electron', 'dist')

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) {
  throw new Error('找不到 node_modules/electron/dist/electron.exe，请先 npm install')
}
if (!fs.existsSync(path.join(root, 'renderer', 'bundle.js'))) {
  throw new Error('找不到 renderer/bundle.js，请先 npm run build')
}

function clearDirectory (dir) {
  if (!fs.existsSync(dir)) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return
  } catch (err) {
    if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(err.code)) throw err
  }
  // 整个目录删不掉时退一步清空内容；仍有文件被占用就抛 ELOCKED
  let blocked = false
  for (const name of fs.readdirSync(dir)) {
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true })
    } catch {
      blocked = true
    }
  }
  if (blocked) {
    const error = new Error(`目录被占用: ${dir}`)
    error.code = 'ELOCKED'
    throw error
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('清理旧目录...')
try {
  clearDirectory(preferredOutDir)
} catch (error) {
  if (error.code !== 'ELOCKED') throw error
  // 不碰被锁的旧目录，改用带时间戳的新目录，保证这次一定能打包
  outDir = path.join(distRoot, `WordLite-${stamp}`)
  console.warn(`旧目录被占用，跳过清理: ${preferredOutDir}`)
  console.warn(`本次改用新目录: ${outDir}`)
  fs.rmSync(outDir, { recursive: true, force: true })
}
fs.mkdirSync(outDir, { recursive: true })

console.log('复制 Electron 运行时...')
fs.cpSync(electronDist, outDir, { recursive: true })
const exePath = path.join(outDir, 'WordLite.exe')
fs.renameSync(path.join(outDir, 'electron.exe'), exePath)

const appDir = path.join(outDir, 'resources', 'app')
fs.mkdirSync(appDir, { recursive: true })
for (const file of ['main.js', 'preload.js']) {
  fs.copyFileSync(path.join(root, file), path.join(appDir, file))
}
fs.cpSync(path.join(root, 'assets'), path.join(appDir, 'assets'), { recursive: true })
fs.mkdirSync(path.join(appDir, 'renderer'), { recursive: true })
for (const file of ['index.html', 'style.css', 'bundle.js']) {
  fs.copyFileSync(path.join(root, 'renderer', file), path.join(appDir, 'renderer', file))
}

// 给 exe 写入图标和版本信息；失败时继续用 Electron 默认图标
const rcedit = path.join(root, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe')
if (fs.existsSync(rcedit)) {
  try {
    console.log('写入 exe 图标和版本信息...')
    execFileSync(rcedit, [
      exePath,
      '--set-icon', path.join(root, 'assets', 'icon.ico'),
      '--set-file-version', pkg.version,
      '--set-product-version', pkg.version,
      '--set-version-string', 'FileDescription', '简写 WordLite',
      '--set-version-string', 'ProductName', '简写',
      '--set-version-string', 'CompanyName', 'WordLite',
      '--set-version-string', 'LegalCopyright', 'Copyright (c) 2026 WordLite contributors'
    ], { stdio: 'inherit' })
  } catch (error) {
    console.warn('exe 图标写入失败，继续使用默认图标:', error.message)
  }
} else {
  console.warn('未安装 rcedit，exe 将继续使用 Electron 默认图标')
}
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
  name: 'wordlite',
  productName: '简写',
  version: pkg.version,
  description: pkg.description,
  main: 'main.js'
}, null, 2), 'utf8')

const launchBat = [
  '@echo off',
  'set "ELECTRON_RUN_AS_NODE="',
  'cd /d "%~dp0"',
  'start "" "WordLite.exe"'
].join('\r\n') + '\r\n'
fs.writeFileSync(path.join(outDir, 'Start WordLite.bat'), launchBat, 'utf8')

fs.writeFileSync(path.join(outDir, '使用说明.txt'), [
  '简写 WordLite 便携版',
  '',
  '双击 WordLite.exe 启动。',
  '如果启动后没有窗口，请双击 Start WordLite.bat（它会清掉本机的 ELECTRON_RUN_AS_NODE 环境变量）。',
  '',
  '特点：',
  '- 不需要安装，复制整个 WordLite 文件夹即可使用',
  '- 完全离线，不上传文件',
  '- 文档默认保存位置由你自己在“另存为”里选择',
  '- 自动保存数据在本机用户目录，不上传',
  '',
  '这是未签名程序，Windows 首次运行可能提示“已保护你的电脑”，选择“更多信息”后仍要运行。',
  '如果发布给别人，建议后续加自定义图标和安装包。'
].join('\r\n'), 'utf8')

console.log('压缩 zip...')
fs.mkdirSync(distRoot, { recursive: true })
const makeZip = (target) => {
  const command = `Compress-Archive -Path '${outDir.replace(/'/g, "''")}' -DestinationPath '${target.replace(/'/g, "''")}' -Force`
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { stdio: 'inherit' })
}
try {
  fs.rmSync(zipPath, { force: true })
  makeZip(zipPath)
} catch (error) {
  zipPath = path.join(distRoot, `WordLite-${pkg.version}-portable-${stamp}.zip`)
  console.warn(`旧 zip 写入失败，改用: ${zipPath}`)
  makeZip(zipPath)
}

const mb = (value) => `${(value / 1024 / 1024).toFixed(1)} MB`
const dirSize = (dir) => {
  let size = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    size += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size
  }
  return size
}
console.log(`便携版目录: ${outDir} (${mb(dirSize(outDir))})`)
console.log(`便携版压缩包: ${zipPath} (${mb(fs.statSync(zipPath).size)})`)
