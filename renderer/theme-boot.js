// 在样式表加载前恢复主题，避免启动时先闪一下经典蓝。
(() => {
  try {
    const raw = localStorage.getItem('wordlite.theme.v1')
    let theme = raw
    try { theme = raw ? JSON.parse(raw) : null } catch {}
    document.documentElement.dataset.theme =
      theme === 'paper-blue' || theme === 'paper-olive' ? theme : 'classic'
    const motionRaw = localStorage.getItem('wordlite.motion.v1')
    let motion = true
    try { motion = motionRaw === null ? true : JSON.parse(motionRaw) !== false } catch {}
    document.documentElement.dataset.motion = motion ? 'on' : 'off'
  } catch {
    document.documentElement.dataset.theme = 'classic'
  }
})()
