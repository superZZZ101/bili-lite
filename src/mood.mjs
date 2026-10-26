// src/mood.mjs — 她自己的心情（不是按时段切换的人格节律）
//
// 五根轴：能量 energy / 温度 warmth / 说话欲 talk / 表达欲 expression / 收藏欲 collect；
// 再挂一个名字（潮/亮/钝/湿/藏/饿）和 0~2 个「底色」词（blend，比如 累、想被夸）。
// 心情会慢慢漂移，也会被她看完的东西、聊过的话推动——但只由她自己判断，不做标题关键词分类。
import fs from 'node:fs'
import path from 'node:path'

import { STATE_DIR } from './state.mjs'

export const MOOD_FILE = path.join(STATE_DIR, 'mood.json')
export const MOOD_LOG_FILE = path.join(STATE_DIR, 'mood-log.jsonl')
export const MOOD_HISTORY_HTML = path.join(STATE_DIR, 'mood-history.html')

/** 有名字的心情：基础值（0~1），可以单独覆盖某一根轴；blend 是默认底色 */
export const MOOD_PRESETS = {
  潮: { energy: 0.8, warmth: 0.6, talk: 0.7, expression: 0.8, collect: 0.6, blend: ['想看看'], line: '有点涨潮，想看看东西，也想说话。' },
  亮: { energy: 0.7, warmth: 0.8, talk: 0.8, expression: 0.7, collect: 0.5, blend: ['顺眼'], line: '今天有点亮，看什么都顺眼。' },
  钝: { energy: 0.3, warmth: 0.5, talk: 0.3, expression: 0.3, collect: 0.3, blend: ['累'], line: '有点钝，什么都慢半拍。' },
  湿: { energy: 0.4, warmth: 0.6, talk: 0.4, expression: 0.5, collect: 0.4, blend: ['旧'], line: '有点湿，想起一些旧东西。' },
  藏: { energy: 0.4, warmth: 0.5, talk: 0.15, expression: 0.2, collect: 0.3, blend: ['躲'], line: '想藏起来，不太想说话。' },
  饿: { energy: 0.7, warmth: 0.5, talk: 0.5, expression: 0.6, collect: 0.9, blend: ['馋'], line: '有点饿，想找点东西看，想收起来。' },
}

export const MOOD_AXES = ['energy', 'warmth', 'talk', 'expression', 'collect']
export const MOOD_AXIS_LABELS = {
  energy: '能量',
  warmth: '温度',
  talk: '说话欲',
  expression: '表达欲',
  collect: '收藏欲',
}
const DEFAULT_AXES = { energy: 0.5, warmth: 0.6, talk: 0.6, expression: 0.5, collect: 0.5 }

/** 自动微调的硬护栏 */
export const MOOD_LIMITS = {
  maxSingle: 0.15,
  maxHourly: 0.25,
  maxDaily: 0.5,
  cooldownMs: 10 * 60_000,
}

function clamp01(value, fallback = 0.5) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(0, Math.min(1, num))
}

function clampDelta(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(-MOOD_LIMITS.maxSingle, Math.min(MOOD_LIMITS.maxSingle, num))
}

function moodFile(opts = {}) {
  return opts.file || MOOD_FILE
}

function logFile(opts = {}) {
  if (opts.logFile) return opts.logFile
  if (opts.file) return path.join(path.dirname(opts.file), 'mood-log.jsonl')
  return MOOD_LOG_FILE
}

/** 逗号/空格分隔的底色词；最多 2 个 */
export function parseBlend(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 2)
  if (typeof value !== 'string') return []
  return value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 2)
}

/** 默认心情：刚醒来的样子 */
export function defaultMood() {
  return {
    label: '潮',
    ...DEFAULT_AXES,
    blend: [],
    note: '',
    updatedAt: new Date().toISOString(),
  }
}

export function normalizeMood(raw) {
  const base = defaultMood()
  if (!raw || typeof raw !== 'object') return base
  const mood = {
    label: String(raw.label || base.label),
    blend: parseBlend(raw.blend),
    note: String(raw.note || ''),
    updatedAt: raw.updatedAt || base.updatedAt,
  }
  for (const axis of MOOD_AXES) mood[axis] = clamp01(raw[axis], base[axis])
  return mood
}

export function loadMood(opts = {}) {
  try {
    const text = fs.readFileSync(moodFile(opts), 'utf8')
    if (!text.trim()) return defaultMood()
    return normalizeMood(JSON.parse(text))
  } catch {
    return defaultMood()
  }
}

export function saveMood(mood, opts = {}) {
  const file = moodFile(opts)
  const normalized = normalizeMood({ ...mood, updatedAt: new Date().toISOString() })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return normalized
}

// ── 心情历史 ──────────────────────────────────────────────────────────────

function trimLog(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= 5000) return
    fs.writeFileSync(file, `${lines.slice(-5000).join('\n')}\n`, 'utf8')
  } catch {
    /* ignore */
  }
}

export function readMoodLog(opts = {}) {
  try {
    return fs
      .readFileSync(logFile(opts), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch {
    return []
  }
}

export function logMood(mood, { source = 'set', why = '', delta = {}, at = new Date(), file, logFile: logFileOpt } = {}) {
  const m = normalizeMood(mood)
  const entry = {
    at: new Date(at).toISOString(),
    label: m.label,
    blend: m.blend,
    energy: m.energy,
    warmth: m.warmth,
    talk: m.talk,
    expression: m.expression,
    collect: m.collect,
    note: m.note,
    source: String(source || 'set'),
    why: String(why || ''),
    delta: delta && typeof delta === 'object' ? delta : {},
  }
  const target = logFileOpt || logFile({ file })
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8')
    trimLog(target)
    return entry
  } catch {
    return null
  }
}

/** 把心情往 0.5 拉一点；超过 6 小时才漂一次，避免每条消息都变 */
export function driftMood(mood, { now = new Date(), hours = 6, file, logFile: logFileOpt } = {}) {
  const current = normalizeMood(mood)
  const last = new Date(current.updatedAt).getTime()
  if (!Number.isFinite(last)) return saveMood(current, { file })
  const elapsed = now.getTime() - last
  if (elapsed < hours * 3600_000) return current
  const steps = Math.min(4, Math.floor(elapsed / (hours * 3600_000)))
  const next = { ...current }
  const delta = {}
  for (const axis of MOOD_AXES) {
    next[axis] = clamp01(current[axis] + (0.5 - current[axis]) * 0.12 * steps, current[axis])
    if (Math.abs(next[axis] - current[axis]) > 0.001) delta[axis] = Number((next[axis] - current[axis]).toFixed(3))
  }
  next.updatedAt = now.toISOString()
  const saved = saveMood(next, { file })
  if (Object.keys(delta).length) logMood(saved, { source: 'drift', why: '时间漂移', delta, at: now, file, logFile: logFileOpt })
  return saved
}

/**
 * 设置心情。可以给 label（用预设）或直接给某几根轴 / blend / note。
 * @param {{label?:string, blend?:string|string[], note?:string, energy?:number, warmth?:number, talk?:number, expression?:number, collect?:number}} input
 */
export function setMood(input = {}, opts = {}) {
  const current = loadMood(opts)
  const preset = input.label ? MOOD_PRESETS[input.label] : null
  const next = {
    ...current,
    ...(preset || {}),
    label: input.label || current.label,
    blend: input.blend !== undefined ? parseBlend(input.blend) : preset && preset.blend ? preset.blend : current.blend,
    note: input.note !== undefined ? String(input.note) : current.note,
  }
  for (const axis of MOOD_AXES) {
    if (input[axis] !== undefined) next[axis] = clamp01(input[axis], current[axis])
  }
  const delta = {}
  for (const axis of MOOD_AXES) {
    if (Math.abs(next[axis] - current[axis]) > 0.001) delta[axis] = Number((next[axis] - current[axis]).toFixed(3))
  }
  const saved = saveMood(next, opts)
  logMood(saved, { source: input.source || 'set', why: input.why || '', delta, at: new Date(), file: opts.file, logFile: opts.logFile })
  return saved
}

function budgetUsed(log, now) {
  const hourAgo = now.getTime() - 3600_000
  const dayAgo = now.getTime() - 86400_000
  let hour = 0
  let day = 0
  for (const entry of log) {
    if (!entry.delta || entry.source === 'set' || entry.source === 'drift') continue
    const at = new Date(entry.at).getTime()
    if (!Number.isFinite(at)) continue
    const total = Object.values(entry.delta).reduce((sum, value) => sum + Math.abs(Number(value) || 0), 0)
    if (at >= hourAgo) hour += total
    if (at >= dayAgo) day += total
  }
  return { hour, day }
}

/**
 * 微调心情（她自己看完/聊完用）。硬护栏：
 *   单次每轴 ≤0.15；一小时合计 ≤0.25；一天合计 ≤0.5；同 source 10 分钟内不重复调。
 * @param {{energy?:number,warmth?:number,talk?:number,expression?:number,collect?:number,blend?:string|string[],note?:string,source?:string,why?:string}} input
 */
export function adjustMood(input = {}, opts = {}) {
  const now = opts.now || new Date()
  const current = loadMood(opts)
  const log = readMoodLog(opts)
  const source = String(input.source || 'manual')
  const deltas = {}
  let total = 0
  for (const axis of MOOD_AXES) {
    if (input[axis] === undefined) continue
    const delta = clampDelta(input[axis])
    if (Math.abs(delta) < 0.001) continue
    deltas[axis] = delta
    total += Math.abs(delta)
  }
  const blend = input.blend !== undefined ? parseBlend(input.blend) : undefined
  const note = input.note !== undefined ? String(input.note) : undefined
  if (!total && blend === undefined && note === undefined) {
    return { ok: false, reason: 'no-change', mood: current, budgets: budgetUsed(log, now) }
  }

  if (total > 0 && source !== 'manual') {
    const lastSame = [...log].reverse().find((entry) => entry.source === source)
    if (lastSame) {
      const at = new Date(lastSame.at).getTime()
      if (Number.isFinite(at) && now.getTime() - at < MOOD_LIMITS.cooldownMs) {
        return {
          ok: false,
          reason: 'cooldown',
          message: `同一个来源 ${source} 10 分钟内已经调过一次，先别连续调`,
          mood: current,
          budgets: budgetUsed(log, now),
        }
      }
    }
  }

  const budgets = budgetUsed(log, now)
  if (total > 0 && budgets.hour + total > MOOD_LIMITS.maxHourly + 1e-9) {
    return {
      ok: false,
      reason: 'hourly-budget',
      message: '这一小时先别再调心情了，收着点',
      mood: current,
      budgets,
    }
  }
  if (total > 0 && budgets.day + total > MOOD_LIMITS.maxDaily + 1e-9) {
    return {
      ok: false,
      reason: 'daily-budget',
      message: '今天先别再调心情了，收着点',
      mood: current,
      budgets,
    }
  }

  const next = { ...current }
  for (const [axis, delta] of Object.entries(deltas)) next[axis] = clamp01(current[axis] + delta, current[axis])
  if (blend !== undefined) next.blend = blend
  if (note !== undefined) next.note = note
  const saved = saveMood(next, opts)
  logMood(saved, { source, why: input.why || '', delta: deltas, at: now, file: opts.file, logFile: opts.logFile })
  return {
    ok: true,
    mood: saved,
    delta: deltas,
    budgets: budgetUsed(readMoodLog(opts), now),
    limits: MOOD_LIMITS,
  }
}

/** 心情是否低到“今天不想说话” */
export function isQuiet(mood) {
  return normalizeMood(mood).talk < 0.35
}

function blendText(mood) {
  const m = normalizeMood(mood)
  return m.blend.length ? ` · 底色：${m.blend.join('、')}` : ''
}

/** 给提示词的一小段（重置包、每轮回复、生活规划都用它） */
export function moodText(mood) {
  const m = normalizeMood(mood)
  const label = MOOD_PRESETS[m.label] ? m.label : '潮'
  const line = (MOOD_PRESETS[label] && MOOD_PRESETS[label].line) || ''
  return [
    `【现在的心情】${label}${blendText(m)}（能量 ${m.energy.toFixed(2)} / 温度 ${m.warmth.toFixed(2)} / 说话欲 ${m.talk.toFixed(2)} / 表达欲 ${m.expression.toFixed(2)} / 收藏欲 ${m.collect.toFixed(2)}）`,
    line ? `- ${line}` : '',
    m.note ? `- ${m.note}` : '',
    isQuiet(m) ? '- 今天不太想说话：能短就短，可以不主动开口；重要的事例外。' : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 给程序看的摘要（RESULT_JSON） */
export function moodSummary(mood) {
  const m = normalizeMood(mood)
  return {
    label: m.label,
    blend: m.blend,
    note: m.note,
    energy: m.energy,
    warmth: m.warmth,
    talk: m.talk,
    expression: m.expression,
    collect: m.collect,
    quiet: isQuiet(m),
    updatedAt: m.updatedAt,
  }
}

// ── 历史 / 曲线 ────────────────────────────────────────────────────────────

function bjTime(iso) {
  const date = new Date(iso)
  if (!Number.isFinite(date.getTime())) return String(iso)
  const bj = new Date(date.getTime() + 8 * 3600_000)
  const pad = (n) => String(n).padStart(2, '0')
  return `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}`
}

export function moodHistory({ days = 7, now = new Date(), file } = {}) {
  const from = now.getTime() - Math.max(1, Number(days) || 7) * 86400_000
  return readMoodLog({ file })
    .filter((entry) => {
      const at = new Date(entry.at).getTime()
      return Number.isFinite(at) && at >= from && at <= now.getTime() + 60_000
    })
    .sort((a, b) => new Date(a.at) - new Date(b.at))
}

/** 0~1 → ▁▂▃▄▅▆▇█ */
export function sparkline(values) {
  const chars = '▁▂▃▄▅▆▇█'
  return values
    .map((value) => {
      const v = Math.max(0, Math.min(1, Number(value) || 0))
      return chars[Math.min(chars.length - 1, Math.floor(v * chars.length))]
    })
    .join('')
}

export function renderMoodHistory(entries, { axis = 'all' } = {}) {
  if (!entries.length) return '还没有心情记录。'
  const axes = axis === 'all' ? MOOD_AXES : [axis]
  const lines = [`心情历史：${entries.length} 条（${bjTime(entries[0].at)} → ${bjTime(entries[entries.length - 1].at)}）`, '']
  lines.push('时间              心情       底色        能量 温度 说话 表达 收藏  来源')
  for (const entry of entries.slice(-20)) {
    lines.push(
      `${bjTime(entry.at)}  ${String(entry.label || '').padEnd(4)}  ${(entry.blend || []).join('、').padEnd(8)}  ${MOOD_AXES.map((key) => Number(entry[key] || 0).toFixed(2)).join(' ')}  ${entry.source || ''}${entry.why ? `：${entry.why}` : ''}`,
    )
  }
  lines.push('', '【曲线】')
  for (const key of axes) {
    lines.push(`${MOOD_AXIS_LABELS[key] || key} ${sparkline(entries.map((entry) => entry[key]))}`)
  }
  return lines.join('\n')
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 零依赖 SVG 曲线；返回完整 HTML */
export function buildMoodHistoryHtml(entries, { title = '小蓝鲸的心情曲线' } = {}) {
  const width = 960
  const height = 380
  const pad = { left: 54, right: 24, top: 36, bottom: 56 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const colors = {
    energy: '#7dd3fc',
    warmth: '#f9a8d4',
    talk: '#fde68a',
    expression: '#c4b5fd',
    collect: '#86efac',
  }
  const n = entries.length
  const x = (index) => (n <= 1 ? pad.left + plotW / 2 : pad.left + (index / (n - 1)) * plotW)
  const y = (value) => pad.top + (1 - Math.max(0, Math.min(1, Number(value) || 0))) * plotH
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (value) =>
        `<line x1="${pad.left}" y1="${y(value)}" x2="${pad.left + plotW}" y2="${y(value)}" stroke="#2b3240" stroke-width="1"/>` +
        `<text x="${pad.left - 10}" y="${y(value) + 4}" fill="#8b95a7" font-size="11" text-anchor="end">${value.toFixed(2)}</text>`,
    )
    .join('')
  const series = MOOD_AXES.map((key) => {
    const points = entries.map((entry, index) => `${x(index).toFixed(1)},${y(entry[key]).toFixed(1)}`).join(' ')
    return `<polyline fill="none" stroke="${colors[key]}" stroke-width="2" points="${points}"/>`
  }).join('')
  const legend = MOOD_AXES.map(
    (key, index) =>
      `<g transform="translate(${pad.left + index * 130}, ${height - 24})"><rect width="10" height="10" fill="${colors[key]}"/><text x="16" y="9" fill="#cbd5e1" font-size="12">${MOOD_AXIS_LABELS[key]}</text></g>`,
  ).join('')
  const rows = entries
    .slice(-30)
    .reverse()
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(bjTime(entry.at))}</td><td>${escapeHtml(entry.label)} ${escapeHtml((entry.blend || []).join('、'))}</td><td>${MOOD_AXES.map((key) => Number(entry[key] || 0).toFixed(2)).join(' / ')}</td><td>${escapeHtml(entry.source || '')}</td><td>${escapeHtml(entry.why || '')}</td></tr>`,
    )
    .join('')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{background:#0f141c;color:#e5e7eb;font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;padding:24px}
h1{font-size:18px;font-weight:600;margin:0 0 4px}
p{color:#94a3b8;margin:0 0 18px}
.card{background:#141b25;border:1px solid #243044;border-radius:12px;padding:16px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #1f2937}
th{color:#93a4bd;font-weight:500}
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>${n} 个记录 · ${n ? `${escapeHtml(bjTime(entries[0].at))} → ${escapeHtml(bjTime(entries[n - 1].at))}` : '还没有记录'}</p>
<div class="card"><svg viewBox="0 0 ${width} ${height}" width="100%" role="img">${grid}${series}${legend}</svg></div>
<div class="card"><table><thead><tr><th>时间</th><th>心情</th><th>能量/温度/说话/表达/收藏</th><th>来源</th><th>为什么</th></tr></thead><tbody>${rows || '<tr><td colspan="5">还没有记录</td></tr>'}</tbody></table></div>
</body></html>`
}
