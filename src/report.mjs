// src/report.mjs — 日报 Markdown + 自包含卡片墙 HTML（零依赖）
// 约定：日报写 reports/YYYY-MM-DD.md（当天多次运行追加「## HH:mm 第N轮」，绝不覆盖）；
// 卡片墙写 state/cardwall.html（内联 CSS、无外部 JS/CSS，图片用 B 站封面并带 no-referrer）。
// 所有用户数据（标题/UP/一句话）进 HTML 前必须 escapeHtml，进 Markdown 前做转义。
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERDICTS, formatDuration, verdictFor } from './pick.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WALL_LIMIT = 60 // 卡片墙最多保留的卡片数，防止文件无限膨胀

// ---------------------------------------------------------------- 路径与通用

let stateModulePromise = null

/** state.mjs 由别的子智能体负责；存在就复用它的 ensureDirs，缺失时本地兜底 */
async function loadStateModule() {
  if (stateModulePromise) return stateModulePromise
  try {
    stateModulePromise = await import('./state.mjs')
    return stateModulePromise
  } catch {
    return null
  }
}

async function ensureDirsSafe() {
  const mod = await loadStateModule()
  if (mod && typeof mod.ensureDirs === 'function') {
    try {
      mod.ensureDirs()
    } catch {
      /* ensureDirs 失败不阻塞，下面再 mkdir */
    }
  }
  await fsp.mkdir(path.join(ROOT, 'state'), { recursive: true })
  await fsp.mkdir(path.join(ROOT, 'reports'), { recursive: true })
}

async function dirsFor(baseDir) {
  if (baseDir) {
    const root = path.resolve(String(baseDir))
    return { reportDir: path.join(root, 'reports'), stateDir: path.join(root, 'state') }
  }
  await ensureDirsSafe()
  return { reportDir: path.join(ROOT, 'reports'), stateDir: path.join(ROOT, 'state') }
}

async function readIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 接受 Date / 时间戳 / 可解析字符串，非法则用当前时间 */
function toDate(input) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) return input
  if (input !== undefined && input !== null && input !== '') {
    const parsed = new Date(input)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }
  return new Date()
}

function localDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

function localTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function localStamp(date) {
  return `${localDate(date)} ${localTime(date)}`
}

/** 统一成 YYYY-MM-DD，非法输入退回今天 */
function normalizeDay(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date
  return localDate(toDate(date))
}

/** 中文轮次：第一轮 … 第十轮，之后用阿拉伯数字 */
const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十']
function roundLabel(n) {
  return n >= 1 && n <= 10 ? `第${CN_NUM[n]}轮` : `第${n}轮`
}

function roundCount(markdown) {
  return (String(markdown || '').match(/^## \d{2}:\d{2} 第/gm) || []).length
}

// ---------------------------------------------------------------- 转义

/** HTML 转义：同时覆盖属性值与文本节点，user data 进 HTML 前必须过这里 */
export function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Markdown 转义：避免标题里的 * [ ] ` < > 破坏版式或注入 HTML */
function escapeMd(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/([[\]*_`<>])/g, '\\$1')
    .replace(/\r?\n/g, ' ')
}

/** 只放行 http(s)，并把协议相对/ http 图片统一成 https */
function safeUrl(value) {
  let url = String(value == null ? '' : value).trim()
  if (!url) return ''
  if (url.startsWith('//')) url = `https:${url}`
  if (/^http:\/\//i.test(url)) url = url.replace(/^http:/i, 'https:')
  if (!/^https?:\/\//i.test(url)) return ''
  return url
}

function bvidUrl(bvid) {
  const id = String(bvid == null ? '' : bvid).trim()
  return /^BV[0-9A-Za-z]+$/.test(id) ? `https://www.bilibili.com/video/${id}` : ''
}

function urlOf(item) {
  return safeUrl(item && item.url) || bvidUrl(item && item.bvid)
}

function verdictOf(item) {
  if (item && VERDICTS.includes(item.verdict)) return item.verdict
  const score = Number(item && item.score)
  return verdictFor(Number.isFinite(score) ? score : 0)
}

/** verdict → 卡片色标 class 与中文名 */
const VERDICT_STYLE = {
  值得看: 'good',
  可以看: 'mid',
  不值当: 'low',
}

// ---------------------------------------------------------------- 卡片墙

function cardHtml(pick) {
  const verdict = verdictOf(pick)
  const style = VERDICT_STYLE[verdict] || 'low'
  const title = escapeHtml(String(pick.title || '').trim() || '（无标题）')
  const owner = escapeHtml(String(pick.owner || '').trim() || '未知 UP')
  const duration = escapeHtml(formatDuration(pick.duration))
  const oneLiner = escapeHtml(String(pick.oneLiner || '').trim())
  const url = escapeHtml(urlOf(pick))
  const cover = escapeHtml(safeUrl(pick.cover))
  const score = Number(pick.score)
  // 手工 pick 可能没有分数，0 分展示出来会误导，这里只在 >0 时显示
  const scoreText = Number.isFinite(score) && score > 0 ? ` · ${Math.round(score)} 分` : ''
  const bvid = escapeHtml(String(pick.bvid || ''))

  const titleNode = url
    ? `<h2><a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a></h2>`
    : `<h2>${title}</h2>`
  const coverNode = cover
    ? `<a class="cover" href="${url || '#'}" target="_blank" rel="noopener noreferrer"><img src="${cover}" alt="封面：${title}" loading="lazy" decoding="async" referrerpolicy="no-referrer"></a>`
    : '<div class="cover cover-empty">暂无封面</div>'
  const lineNode = oneLiner
    ? `<p class="line"><span class="badge ${style}">${escapeHtml(verdict)}</span>${oneLiner}</p>`
    : `<p class="line"><span class="badge ${style}">${escapeHtml(verdict)}</span>（还没来得及写一句话）</p>`
  const linkNode = url
    ? `<p class="link"><a href="${url}" target="_blank" rel="noopener noreferrer">${bvid || '打开视频'}${scoreText}</a></p>`
    : `<p class="link">${bvid || '无链接'}${scoreText}</p>`

  return [
    `<article class="card ${style}">`,
    coverNode,
    '<div class="body">',
    titleNode,
    `<p class="meta">UP：${owner} · 时长 ${duration}</p>`,
    lineNode,
    linkNode,
    '</div>',
    '</article>',
  ].join('')
}

/**
 * 渲染卡片墙：自包含 HTML（内联 CSS、无外链 JS/CSS），深色主题，卡片 inline-block 自适应列宽。
 * @param {object[]} picks
 * @param {{title?:string, generatedAt?:Date|string|number}} [opts]
 * @returns {string}
 */
export function renderCardwall(picks, opts = {}) {
  const list = (Array.isArray(picks) ? picks : []).filter(Boolean).slice(0, WALL_LIMIT)
  const generatedDate = toDate(opts.generatedAt)
  const day = localDate(generatedDate)
  const title = String(opts.title || '').trim() || `bili-lite 卡片墙 · ${day}`
  const counts = { 值得看: 0, 可以看: 0, 不值当: 0 }
  for (const pick of list) counts[verdictOf(pick)] += 1
  const summary =
    `共 ${list.length} 张卡片 · 值得看 ${counts['值得看']} / 可以看 ${counts['可以看']} / 不值当 ${counts['不值当']}` +
    ` · 生成于 ${localStamp(generatedDate)}`

  const cards = list.map(cardHtml).join('')
  const body = list.length
    ? `<main class="wall">${cards}</main>`
    : '<main class="wall"><p class="empty">这一轮没有投递的候选。</p></main>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #0d1117;
  color: #e6edf3;
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
}
header { padding: 28px 24px 10px; }
h1 { margin: 0 0 6px; font-size: 22px; font-weight: 650; letter-spacing: .3px; }
.sub { margin: 0; color: #8b949e; font-size: 13px; }
.wall { padding: 10px 14px 34px; font-size: 0; }
.empty { font-size: 14px; color: #8b949e; padding: 18px 10px; }
.card {
  display: inline-block;
  vertical-align: top;
  width: 320px;
  max-width: 100%;
  margin: 10px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  overflow: hidden;
  font-size: 14px;
  transition: border-color .15s ease, transform .15s ease;
}
.card:hover { border-color: #58a6ff; transform: translateY(-2px); }
.cover { display: block; background: #0d1117; }
.cover img { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; }
.cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  color: #484f58;
  font-size: 12px;
  letter-spacing: .5px;
}
.body { padding: 12px 14px 14px; }
.card h2 { margin: 0 0 8px; font-size: 15px; line-height: 1.45; font-weight: 600; }
.card h2 a { color: #e6edf3; text-decoration: none; }
.card h2 a:hover { color: #58a6ff; }
.meta { margin: 0 0 8px; color: #8b949e; font-size: 12px; }
.line { margin: 0 0 10px; color: #c9d1d9; font-size: 13px; word-break: break-word; }
.badge {
  display: inline-block;
  margin-right: 7px;
  padding: 0 8px;
  border: 1px solid;
  border-radius: 999px;
  font-size: 12px;
  line-height: 20px;
  vertical-align: 1px;
}
.badge.good { color: #3fb950; border-color: #238636; background: rgba(63, 185, 80, .12); }
.badge.mid { color: #d29922; border-color: #9e6a03; background: rgba(210, 153, 34, .12); }
.badge.low { color: #8b949e; border-color: #30363d; background: rgba(110, 118, 129, .12); }
.link { margin: 0; color: #8b949e; font-size: 12px; word-break: break-all; }
.link a { color: #58a6ff; text-decoration: none; }
.link a:hover { text-decoration: underline; }
footer { padding: 0 24px 32px; color: #484f58; font-size: 12px; }
@media (max-width: 720px) {
  .card { width: 100%; margin: 8px 0; }
}
</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p class="sub">${escapeHtml(summary)}</p>
</header>
${body}
<footer>bili-lite · 本地生成，无外部 JS/CSS 依赖 · 封面来自 B 站图床（no-referrer）</footer>
</body>
</html>
`
}

// ---------------------------------------------------------------- 日报

function pickLines(pick) {
  const url = urlOf(pick)
  const title = escapeMd(String(pick.title || '').trim() || '（无标题）')
  const owner = escapeMd(String(pick.owner || '').trim() || '未知 UP')
  const verdict = verdictOf(pick)
  const oneLiner = escapeMd(String(pick.oneLiner || '').trim() || '暂无')
  const heading = url ? `[${title}](${url})` : title
  const lines = [
    `1. **${heading}** — **${verdict}**`,
    `   - UP：${owner} · 时长 ${formatDuration(pick.duration)}`,
    `   - 一句话：${oneLiner}`,
  ]
  lines.push(`   - 链接：${url ? `<${url}>` : '（无）'}`)
  return lines.join('\n')
}

function statsLine({ scannedCount, list, state }) {
  const counts = { 值得看: 0, 可以看: 0, 不值当: 0 }
  for (const pick of list) counts[verdictOf(pick)] += 1
  const seenCount = state && state.seen && typeof state.seen === 'object' ? Object.keys(state.seen).length : 0
  const pickCount = state && Array.isArray(state.picks) ? state.picks.length : 0
  return (
    `统计：本次扫描 ${scannedCount} 条，本轮投递 ${list.length} 条` +
    `（值得看 ${counts['值得看']} / 可以看 ${counts['可以看']} / 不值当 ${counts['不值当']}），` +
    `累计见过 ${seenCount} 条，累计 pick ${pickCount} 条。`
  )
}

function roundChunk({ markdown, list, scannedCount, mode, time, round, state, day }) {
  const lines = []
  if (!markdown.trim()) {
    lines.push(`# bili-lite 日报 · ${day}`, '')
    lines.push(`- 日期：${day}`)
    lines.push(`- 本次扫描：${scannedCount} 条`)
    lines.push(`- 模式：${mode}`)
    lines.push(`- 生成：${localStamp(time)}`)
    lines.push('')
  }
  lines.push(`## ${localTime(time)} ${roundLabel(round)}`, '')
  if (markdown.trim()) {
    lines.push(`- 本次扫描：${scannedCount} 条`)
    lines.push(`- 模式：${mode}`)
    lines.push('')
  }
  if (list.length) {
    list.forEach((pick, index) => {
      // pickLines 固定以 "1." 开头，这里替换成真实序号
      lines.push(pickLines(pick).replace(/^1\. /, `${index + 1}. `))
    })
    lines.push('')
  } else {
    lines.push('本轮没有投递。', '')
  }
  lines.push(statsLine({ scannedCount, list, state }))
  lines.push('')
  return lines.join('\n')
}

/** pickedAt 是 UTC ISO 字符串，但日报按本地日期归档，这里统一成本地日 */
function pickedDay(pick) {
  const time = new Date(pick && pick.pickedAt ? pick.pickedAt : 0)
  return Number.isNaN(time.getTime()) ? '' : localDate(time)
}

/** 卡片墙要展示「今天已投递的全部」：state.picks 里今天的 + 本轮，按 pickedAt 新的在前 */
function wallPicks(state, list, day) {
  // 本轮 pick 对象最完整（含封面/理由），优先放入，去重时就能盖过 state 里的摘要版
  const pool = [...list]
  if (state && Array.isArray(state.picks)) {
    for (const pick of state.picks) {
      if (!pick || !pick.bvid) continue
      if (pickedDay(pick) !== day) continue
      pool.push(pick)
    }
  }
  const seen = new Set()
  const merged = []
  for (const pick of pool) {
    if (seen.has(pick.bvid)) continue
    seen.add(pick.bvid)
    merged.push(pick)
  }
  const stamp = (pick) => {
    const value = new Date(pick && pick.pickedAt ? pick.pickedAt : 0).getTime()
    return Number.isFinite(value) ? value : 0
  }
  return merged.sort((a, b) => stamp(b) - stamp(a)).slice(0, WALL_LIMIT)
}

/**
 * 写当天日报（存在则追加轮次，不覆盖）并刷新卡片墙。
 * @param {object} state State
 * @param {{date?:string|Date, picks?:object[], scannedCount?:number, mode?:string, now?:Date|string|number, baseDir?:string}} opts
 *   baseDir 仅用于测试/自定义输出目录（默认项目根下的 reports/ 与 state/）
 * @returns {Promise<{mdPath:string, htmlPath:string}>}
 */
export async function writeDigest(state, opts = {}) {
  const {
    date,
    picks,
    scannedCount = 0,
    mode = 'manual',
    now,
    baseDir,
  } = opts || {}
  const list = (Array.isArray(picks) ? picks : []).filter(Boolean)
  const day = normalizeDay(date)
  const time = toDate(now)
  const dirs = await dirsFor(baseDir)
  await fsp.mkdir(dirs.reportDir, { recursive: true })
  await fsp.mkdir(dirs.stateDir, { recursive: true })

  const mdPath = path.join(dirs.reportDir, `${day}.md`)
  const existing = await readIfExists(mdPath)
  const round = roundCount(existing) + 1
  const chunk = roundChunk({
    markdown: existing,
    list,
    scannedCount: Number(scannedCount) || 0,
    mode: String(mode || 'manual'),
    time,
    round,
    state,
    day,
  })
  const markdown = existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${chunk}` : chunk
  await fsp.writeFile(mdPath, markdown, 'utf8')

  const htmlPath = path.join(dirs.stateDir, 'cardwall.html')
  const html = renderCardwall(wallPicks(state, list, day), {
    title: `bili-lite 卡片墙 · ${day}`,
    generatedAt: time,
  })
  await fsp.writeFile(htmlPath, html, 'utf8')
  return { mdPath, htmlPath }
}
