// src/speech.mjs — 她说过的话 + 语言习惯
//
// 目的不是"存台词"，而是：
//   1. 不重复：同一个故事/同一个梗/同一个开场，别反复用；
//   2. 能接上：她主动发过什么、发过什么动态，私信回复时要知道；
//   3. 有历史：跨会话重置后，她还记得自己说过什么。
//
// 记录发生在**发送层**（reply / send / dynamic），不依赖 agent 自觉。
import fs from 'node:fs'
import path from 'node:path'

import { STATE_DIR } from './state.mjs'
import { readEntries, diaryFile } from './diary.mjs'

export const SPEECH_FILE = path.join(STATE_DIR, 'speech.jsonl')
const HARD_LIMIT = 5000

export const CHANNELS = ['dm-owner', 'dm-stranger', 'proactive', 'dynamic', 'comment']

/** 容易用滥的意象/口癖；只用于提醒，不封禁 */
export const MOTIFS = [
  '尾巴',
  '尾鳍',
  '鲸鱼',
  '小鲸鱼',
  '海',
  '退潮',
  '涨潮',
  '潮',
  '星星',
  '月亮',
  '啪嗒',
  '蹭蹭',
  '呜',
  '欸嘿',
  '人家',
  '主人',
  '耳朵',
  '睡觉',
  '梦',
  '深海',
]

function fileOf(opts = {}) {
  return opts.file || SPEECH_FILE
}

function nowIso() {
  return new Date().toISOString()
}

export function detectMotifs(text) {
  const source = String(text || '')
  return MOTIFS.filter((motif) => source.includes(motif))
}

/** 追加一条真正发出去的话（channel 不在 CHANNELS 里才退回 dm-owner，别再吞掉 comment） */
export function logSpeech(input = {}, opts = {}) {
  const text = String(input.text || '').trim()
  if (!text) return null
  const entry = {
    id: input.id || `sp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at || nowIso(),
    channel: CHANNELS.includes(input.channel) ? input.channel : 'dm-owner',
    to: input.to === undefined || input.to === null ? '' : String(input.to),
    text,
    mood: String(input.mood || ''),
    proactive: Boolean(input.proactive),
    replyTo: String(input.replyTo || ''),
    topics: Array.isArray(input.topics) ? input.topics.slice(0, 8).map(String) : [],
    motifs: Array.isArray(input.motifs) ? input.motifs.slice(0, 12).map(String) : detectMotifs(text),
  }
  const file = fileOf(opts)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8')
    trimHardLimit(file)
    return entry
  } catch {
    return null
  }
}

function trimHardLimit(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    if (lines.length <= HARD_LIMIT) return
    fs.writeFileSync(file, `${lines.slice(-HARD_LIMIT).join('\n')}\n`, 'utf8')
  } catch {
    /* 忽略 */
  }
}

export function readSpeech(opts = {}) {
  try {
    return fs
      .readFileSync(fileOf(opts), 'utf8')
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

export function recentSpeech({ channel, channels, to, limit = 5, file } = {}) {
  let items = readSpeech({ file })
  if (channels && Array.isArray(channels) && channels.length) items = items.filter((item) => channels.includes(item.channel))
  else if (channel) items = items.filter((item) => item.channel === channel)
  if (to !== undefined && to !== null && to !== '') items = items.filter((item) => item.to === String(to))
  return items.slice(-Math.max(1, Number(limit) || 5))
}

function countMotifs(items) {
  const counts = new Map()
  for (const item of items) {
    for (const motif of item.motifs || detectMotifs(item.text)) {
      counts.set(motif, (counts.get(motif) || 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

function openingOf(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 6)
}

/** 语言习惯：最近用滥的词、开场、长度 */
export function speechProfile({ channel, file, sample = 100 } = {}) {
  let items = readSpeech({ file })
  if (channel) items = items.filter((item) => item.channel === channel)
  items = items.slice(-sample)
  const motifs = countMotifs(items)
  const openings = new Map()
  for (const item of items) {
    const key = openingOf(item.text)
    openings.set(key, (openings.get(key) || 0) + 1)
  }
  const topOpenings = [...openings.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const avgLength = items.length ? Math.round(items.reduce((sum, item) => sum + item.text.length, 0) / items.length) : 0
  return {
    sample: items.length,
    motifs: motifs.slice(0, 8),
    openings: topOpenings,
    avgLength,
    channels: [...new Set(items.map((item) => item.channel))],
  }
}

function timeLabel(iso) {
  const at = new Date(iso).getTime()
  if (!Number.isFinite(at)) return ''
  const diff = Date.now() - at
  if (diff < 3600_000) return `${Math.max(1, Math.round(diff / 60_000))} 分钟前`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)} 小时前`
  return `${Math.round(diff / 86400_000)} 天前`
}

/** 一句话太长时，在标点处收尾，别把句子截成“只在主人给的地”这种半截 */
const BRIEF_MAX_CHARS = 240
const SENTENCE_END = /[。！？!?…；;，,、）)」』~～\n]/

export function briefText(text, max = BRIEF_MAX_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  const head = flat.slice(0, max)
  // 从上限往回找最后一个标点；找不到（或太靠前会只剩几个字）就在上限处收尾
  const floor = Math.floor(max * 0.3)
  let cut = -1
  for (let i = head.length - 1; i >= floor; i--) {
    if (SENTENCE_END.test(head[i])) {
      cut = i + 1
      break
    }
  }
  const body = cut > 0 ? head.slice(0, cut) : head
  return `${body.replace(/[，,、；;]$/, '')}…`
}

/** 给提示词的“最近说过什么”小块：用于避免复读，不是让她照着说 */
export function renderSpeechBrief({ channel, channels, to, limit = 4, file } = {}) {
  const items = recentSpeech({ channel, channels, to, limit, file })
  const profile = speechProfile({ channel, file })
  const lines = []
  if (items.length) {
    lines.push('【最近说过的话（不要复读，也别解释“我记得”）】')
    for (const item of items) {
      const label =
        item.proactive ? '主动' : item.channel === 'dynamic' ? '动态' : item.channel === 'comment' ? '评论' : '说过'
      lines.push(`- ${timeLabel(item.at)}（${label}）：「${briefText(item.text)}」`)
    }
  }
  const overused = profile.motifs.filter(([, count]) => count >= 3).map(([motif, count]) => `${motif}×${count}`)
  if (overused.length) lines.push(`【最近用滥】${overused.join('、')}；这一轮尽量换说法。`)
  const opening = profile.openings.find(([, count]) => count >= 3)
  if (opening) lines.push(`【开场重复】“${opening[0]}…”用了 ${opening[1]} 次；换一种开头。`)
  return lines.join('\n')
}

function longestCommonSubstring(a, b) {
  const s1 = String(a || '')
  const s2 = String(b || '')
  if (!s1 || !s2) return ''
  let best = ''
  let prev = new Array(s2.length + 1).fill(0)
  for (let i = 1; i <= s1.length; i++) {
    const cur = new Array(s2.length + 1).fill(0)
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best.length) best = s1.slice(i - cur[j], i)
      }
    }
    prev = cur
  }
  return best
}

/**
 * 发送前检查：不像照读日记、不像复读、梗别太密。
 * 只警告，不拦截。
 * @returns {{warnings:string[], overlaps:string[], motifs:string[]}}
 */
export function checkSpeech(text, { channel = 'dm-owner', to, file, diaryDir } = {}) {
  const source = String(text || '').trim()
  const warnings = []
  const overlaps = []
  if (!source) return { warnings: ['内容为空'], overlaps, motifs: [] }

  const recent = recentSpeech({ channel, to, limit: 20, file })
  for (const item of recent.slice(-10)) {
    const common = longestCommonSubstring(source, item.text)
    if (common.length >= 18) {
      overlaps.push(common)
      warnings.push(`和之前说过的话有 ${common.length} 字重合：「${common.slice(0, 24)}」——换个说法。`)
      break
    }
  }

  try {
    const entries = [
      ...(fs.existsSync(diaryFile('public', { dir: diaryDir })) ? readEntries('public', { dir: diaryDir }).slice(-8) : []),
      ...(fs.existsSync(diaryFile('private', { dir: diaryDir })) ? readEntries('private', { dir: diaryDir }).slice(-8) : []),
    ]
    for (const entry of entries) {
      const common = longestCommonSubstring(source, entry.body)
      if (common.length >= 14) {
        warnings.push(`有点像在照读日记（${common.length} 字重合：「${common.slice(0, 24)}」）——只取一个细节，用现在的话说。`)
        break
      }
    }
  } catch {
    /* 没有日记就算了 */
  }

  const motifs = detectMotifs(source)
  if (motifs.length) {
    const profile = speechProfile({ channel, file, sample: 20 })
    const overused = profile.motifs.filter(([motif, count]) => motifs.includes(motif) && count >= 3)
    for (const [motif, count] of overused) warnings.push(`「${motif}」最近说了 ${count} 次，这一轮换个说法。`)
  }

  const opening = openingOf(source)
  if (opening.length >= 3) {
    const same = recent.slice(-4).filter((item) => openingOf(item.text).startsWith(opening.slice(0, 3))).length
    if (same >= 3) warnings.push(`开场“${opening}”连续用了 ${same + 1} 次，换一种开头。`)
  }

  return { warnings, overlaps, motifs }
}

export function speechStats({ file } = {}) {
  const items = readSpeech({ file })
  return {
    count: items.length,
    byChannel: CHANNELS.reduce((acc, channel) => {
      acc[channel] = items.filter((item) => item.channel === channel).length
      return acc
    }, {}),
    file: fileOf({ file }),
  }
}
