// src/pick.mjs — 候选打分 / 排序 / 兜底文案（纯启发式，零依赖）
// 设计原则：
// 1. 只用候选元数据（标题、时长、互动、简介、标签）判断，不臆测视频具体内容；
// 2. 互动用「播放量比值分档 + 总分封顶」，不用绝对播放量，避免大 UP 碾压小 UP；
// 3. 正常分值是 0~100 的整数；已看过的候选给 -1000，保证排到最后；
// 4. reasons 最多 4 条、每条 ≤24 字，方便直接塞进卡片或一句话。

/** 三种 verdict，顺序固定 */
export const VERDICTS = ['值得看', '可以看', '不值当']

const DEFAULT_MIN = 180 // 3 分钟
const DEFAULT_MAX = 1800 // 30 分钟
const MAX_REASON = 24

// 标题里的「有信息量」信号词：命中加分（只取前 2 个，最多 +10）
const GOOD_WORDS = ['教程', '科普', '纪录片', '解析', '实测', '避坑', '原理', '复盘', '指南', '拆解', '详解', '硬核']
// 标题里的「大概率不是正片」信号词：命中减分（只取前 2 个，最多 -12）
const BAD_WORDS = ['直播回放', '纯音乐', '合集', '预告', '切片', '带货', '广告', '搬运']

/** 按字符截断（中文按 1 个字算），超长时补省略号 */
function cut(text, max = MAX_REASON) {
  const chars = [...String(text == null ? '' : text).replace(/\s+/g, ' ').trim()]
  if (chars.length <= max) return chars.join('')
  return `${chars.slice(0, Math.max(1, max - 1)).join('')}…`
}

/** 秒 → 12:34 / 1:02:03 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** 秒 → 人话时长（45 秒 / 18 分钟 / 1 小时 5 分），供一句话文案使用 */
function minutesText(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  if (total < 60) return `${total} 秒`
  const m = Math.round(total / 60)
  if (m < 60) return `${m} 分钟`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} 小时` : `${h} 小时 ${m % 60} 分`
}

/** cfg 的时长偏好区间，缺省时退回 3~30 分钟 */
function rangeOf(cfg = {}) {
  const min = Number(cfg.minDuration)
  const max = Number(cfg.maxDuration)
  return {
    min: Number.isFinite(min) && min > 0 ? min : DEFAULT_MIN,
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX,
  }
}

/** 兼容 state.seen（对象）与 bvid 数组两种写法 */
function hasSeen(map, bvid) {
  if (!map || !bvid) return false
  if (Array.isArray(map)) return map.includes(bvid)
  return Boolean(map[bvid])
}

function isSeen(candidate, cfg) {
  if (!candidate) return false
  if (candidate.__seen === true || candidate.seen === true) return true
  const map = cfg && (cfg.seen || cfg.__seen)
  return hasSeen(map, candidate.bvid)
}

/** 统一取互动数据（兼容 bili.mjs 的 stat 与扁平字段） */
function statsOf(candidate) {
  const stat = candidate.stat || {}
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    view: num(stat.view !== undefined ? stat.view : candidate.view),
    like: num(stat.like !== undefined ? stat.like : candidate.like),
    reply: num(stat.reply !== undefined ? stat.reply : candidate.reply),
    danmaku: num(stat.danmaku !== undefined ? stat.danmaku : candidate.danmaku),
  }
}

// 互动率参考阈值（点赞率 / 评论率 / 弹幕率）。B 站整体点赞率约 2%~5%，
// 6% 以上就算高；评论和弹幕只作为辅助信号，总量封顶 12 分。
const LIKE_TIERS = [
  { min: 0.08, bonus: 8, text: '点赞率很高' },
  { min: 0.04, bonus: 6, text: '点赞率高' },
  { min: 0.02, bonus: 4, text: '点赞率不错' },
  { min: 0.008, bonus: 2, text: '点赞率正常' },
]
const REPLY_TIERS = [
  { min: 0.01, bonus: 4 },
  { min: 0.004, bonus: 2 },
]
const DANMAKU_TIERS = [
  { min: 0.05, bonus: 3 },
  { min: 0.015, bonus: 2 },
]

function pickTier(tiers, value) {
  for (const tier of tiers) {
    if (value >= tier.min) return tier
  }
  return null
}

/** 互动率评分：返回单条 reason（避免 reasons 被互动数据占满） */
function interactionNote(candidate) {
  const { view, like, reply, danmaku } = statsOf(candidate)
  // 播放太少时比值失真，不做判断也不扣分
  if (view < 1000) return null
  const likeTier = pickTier(LIKE_TIERS, like / view)
  const replyTier = pickTier(REPLY_TIERS, reply / view)
  const danmakuTier = pickTier(DANMAKU_TIERS, danmaku / view)
  let bonus = (likeTier ? likeTier.bonus : 0) + (replyTier ? replyTier.bonus : 0) + (danmakuTier ? danmakuTier.bonus : 0)
  bonus = Math.min(12, bonus)
  if (bonus <= 0) return null
  const likePct = (like / view) * 100
  const text = likePct >= 0.8 ? `点赞率 ${likePct.toFixed(1)}%，互动不错` : '评论弹幕活跃'
  return { kind: 'interaction', text: cut(text), cue: '互动率不错，不是冷门片', impact: bonus }
}

/**
 * 核心分析：返回 score、notes（含 cue 供兜底文案用）与 seen 标记。
 * 分值 = 50 基线 + 各项加减；时长不在偏好区间时额外封顶 35 分。
 */
function analyze(candidate, cfg = {}) {
  const c = candidate || {}
  if (isSeen(c, cfg)) {
    return {
      score: -1000,
      seen: true,
      notes: [{ kind: 'seen', text: '已看过，排到队尾', cue: '这条已经看过了', impact: -1000 }],
      reasons: ['已看过，排到队尾'],
    }
  }

  const range = rangeOf(cfg)
  const notes = []
  let raw = 50
  let capped = false

  // —— 1. 时长：3~30 分钟最舒服；太短/太长都压分 ——
  const duration = Number(c.duration) || 0
  if (duration <= 0) {
    raw -= 12
    notes.push({ kind: 'duration-unknown', text: '时长未知', cue: '时长没拿到', impact: -12 })
  } else if (duration < range.min) {
    capped = true
    if (duration < 60) {
      raw -= 22
      notes.push({ kind: 'duration-short', text: `只有 ${formatDuration(duration)}，太短`, cue: '太短，信息量存疑', impact: -22 })
    } else {
      raw -= 15
      notes.push({ kind: 'duration-short', text: `${minutesText(duration)}，短于偏好下限`, cue: '偏短，怕不够看', impact: -15 })
    }
  } else if (duration > range.max) {
    capped = true
    raw -= 20
    notes.push({ kind: 'duration-long', text: `${minutesText(duration)}，超出偏好上限`, cue: '太长，时间成本高', impact: -20 })
    if (duration > 3600) {
      raw -= 8
      notes.push({ kind: 'duration-hour', text: '超过 1 小时，成本偏高', cue: '一小时以上，时间成本太高', impact: -8 })
    }
  } else if (duration < 60) {
    raw -= 18
    notes.push({ kind: 'duration-short', text: '不到 1 分钟，信息量存疑', cue: '太短，信息量存疑', impact: -18 })
  } else if (duration < 180) {
    // 1~3 分钟落在默认区间（minDuration=60）内，但离「3~30 分钟」的舒适区还差一点
    raw -= 4
    notes.push({ kind: 'duration-short', text: `${minutesText(duration)}，偏短`, cue: '偏短，怕不够看', impact: -4 })
  } else if (duration <= 1800) {
    raw += 12
    notes.push({ kind: 'duration-ok', text: `${minutesText(duration)}，时长合适`, cue: '正好能看完', impact: 12 })
  } else {
    raw += 4
    notes.push({ kind: 'duration-mid', text: `${minutesText(duration)}，要留整块时间`, cue: '要留整块时间', impact: 4 })
    if (duration > 3600) {
      raw -= 8
      notes.push({ kind: 'duration-hour', text: '超过 1 小时，成本偏高', cue: '一小时以上，时间成本太高', impact: -8 })
    }
  }

  // —— 2. 标题信号 ——
  const title = String(c.title || '')
  const goodHits = GOOD_WORDS.filter((word) => title.includes(word)).slice(0, 2)
  for (const word of goodHits) {
    raw += 5
    notes.push({ kind: 'title-good', text: `标题像干货（${word}）`, cue: `看着像${word}类干货`, impact: 5, value: word })
  }
  if (/[？?]|^\s*(为什么|怎么|如何|能不能|要不要|到底|有没有)/.test(title)) {
    raw += 4
    notes.push({ kind: 'title-question', text: '标题是疑问句', cue: '标题有钩子', impact: 4 })
  }
  // 只认阿拉伯数字：中文数字太容易误判（「一个」「一直」并不是信息量信号）
  if (/\d/.test(title)) {
    raw += 3
    notes.push({ kind: 'title-number', text: '标题带具体数字', cue: '标题具体', impact: 3 })
  }
  const badHits = BAD_WORDS.filter((word) => title.includes(word)).slice(0, 2)
  for (const word of badHits) {
    raw -= 6
    notes.push({ kind: 'title-bad', text: `标题含「${word}」，不像正片`, cue: `像${word}，不像正片`, impact: -6, value: word })
  }
  // 标题党：感叹号 ≥3 个就扣分，不按单个感叹号累计
  const bangs = (title.match(/[!！]/g) || []).length
  if (bangs >= 3) {
    raw -= 8
    notes.push({ kind: 'title-bang', text: '感叹号太多，像标题党', cue: '标题党味重', impact: -8 })
  }

  // —— 3. 互动率（比值 + 封顶） ——
  const interaction = interactionNote(c)
  if (interaction) {
    raw += interaction.impact
    notes.push(interaction)
  }

  // —— 4. 简介 / 标签里的偏好关键词 ——
  const prefer = Array.isArray(cfg.preferKeywords) ? cfg.preferKeywords : []
  const haystack = [c.title, c.desc, ...(Array.isArray(c.tags) ? c.tags : [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  const matched = []
  for (const rawKeyword of prefer) {
    const keyword = String(rawKeyword == null ? '' : rawKeyword).trim()
    if (!keyword) continue
    const lower = keyword.toLowerCase()
    if (matched.some((m) => m.toLowerCase() === lower)) continue
    if (haystack.includes(lower)) matched.push(keyword)
  }
  for (const keyword of matched.slice(0, 2)) {
    raw += 4
    notes.push({
      kind: 'keyword',
      text: cut(`命中偏好：${keyword}`),
      cue: `讲的正好是你关心的「${keyword}」`,
      impact: 4,
      value: keyword,
    })
  }

  if (notes.length === 0) {
    notes.push({ kind: 'neutral', text: '没有明显加分项', cue: '信息量还看不出来', impact: 0 })
  }

  let score = raw
  if (capped) score = Math.min(score, 35) // 区间之外直接低分，不参与正常竞争
  score = Math.max(0, Math.min(100, Math.round(score)))

  // reasons 按「影响绝对值」排序，让人一眼看到决定性理由；最多 4 条、每条 ≤24 字
  const reasons = notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => Math.abs(b.note.impact) - Math.abs(a.note.impact) || a.index - b.index)
    .slice(0, 4)
    .map(({ note }) => cut(note.text))

  return { score, seen: false, notes, reasons }
}

/**
 * 给单个候选打分。
 * @param {object} c Candidate
 * @param {object} cfg { minDuration, maxDuration, preferKeywords, seen? }
 * @returns {{score:number, reasons:string[]}}
 */
export function scoreCandidate(c, cfg = {}) {
  const { score, reasons } = analyze(c, cfg)
  return { score, reasons }
}

/** verdict 阈值：>=75 值得看，>=50 可以看，其余不值当 */
export function verdictFor(score) {
  const value = Number(score)
  if (!Number.isFinite(value)) return '不值当'
  if (value >= 75) return '值得看'
  if (value >= 50) return '可以看'
  return '不值当'
}

/**
 * 过滤（时长区间 / 已看过）、按 bvid 去重、打分并从高到低排序。
 * 同分时 pubdate 新的在前；时长未知（0）的候选保留，交给打分判断。
 * @param {object[]} list
 * @param {object} cfg
 * @param {Record<string, any>} [seen] state.seen；不传则读 cfg.seen
 */
export function rankCandidates(list, cfg = {}, seen) {
  const range = rangeOf(cfg)
  const seenMap = seen || (cfg && (cfg.seen || cfg.__seen)) || {}
  const picked = new Map()

  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.bvid) continue
    const duration = Number(item.duration) || 0
    if (duration > 0 && (duration < range.min || duration > range.max)) continue
    if (hasSeen(seenMap, item.bvid)) continue

    const { score, reasons } = scoreCandidate(item, cfg)
    const candidate = { ...item, score, reasons }
    const previous = picked.get(item.bvid)
    // 同一 bvid 重复出现时，保留信息更全（分值更高）的那份
    if (!previous || score > previous.score) picked.set(item.bvid, candidate)
  }

  return [...picked.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const pubA = Number(a.pubdate) || 0
    const pubB = Number(b.pubdate) || 0
    if (pubB !== pubA) return pubB - pubA
    return String(a.bvid).localeCompare(String(b.bvid))
  })
}

/** 兜底一句话：只复述元数据，不编造视频内容 */
function autoSentence(c, analysis, verdict) {
  const owner = String(c.owner || '').trim() || '这个 UP'
  const duration = Number(c.duration) || 0
  // 时长未知时不硬写「0 秒」，换成中性主语
  const subject = duration > 0 ? `${owner} 这条 ${minutesText(duration)}` : `${owner} 这条视频`
  const positive = analysis.notes.filter((note) => note.impact > 0)
  const negative = analysis.notes.filter((note) => note.impact < 0)
  const note = verdict === '不值当' ? negative[0] : positive[0]
  const cue = note ? note.cue : verdict === '不值当' ? '信息量还看不出来' : '没什么特别亮点'
  if (verdict === '值得看') return `${subject}，${cue}，值得占一次注意力`
  if (verdict === '可以看') return `${subject}，${cue}，有空可以看看`
  return `${subject}，${cue}，这次先跳过`
}

/**
 * 组装 Pick。verdict / oneLiner 缺省时按分数与启发式补齐。
 * @param {object} c Candidate（带 score/reasons 更佳）
 * @param {{verdict?:string, oneLiner?:string, pickedAt?:string}} opts
 */
export function makePick(c, { verdict, oneLiner, pickedAt } = {}) {
  const candidate = c || {}
  const score = Number.isFinite(Number(candidate.score)) ? Math.round(Number(candidate.score)) : 0
  const finalVerdict = VERDICTS.includes(verdict) ? verdict : verdictFor(score)
  const fallback = autoSentence(candidate, analyze(candidate, {}), finalVerdict)
  const pickedTime = pickedAt
    ? pickedAt instanceof Date
      ? pickedAt.toISOString()
      : String(pickedAt)
    : new Date().toISOString()
  return {
    ...candidate,
    score,
    reasons: Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 4) : [],
    verdict: finalVerdict,
    oneLiner: typeof oneLiner === 'string' && oneLiner.trim() ? oneLiner.trim() : fallback,
    pickedAt: pickedTime,
  }
}

/**
 * 无模型时的自动挑选：启发式打分 + 模板一句话。
 * @param {object} c
 * @param {object} cfg
 * @returns {object} Pick
 */
export function autoPick(c, cfg = {}) {
  const candidate = c || {}
  const analysis = analyze(candidate, cfg)
  const verdict = verdictFor(analysis.score)
  const oneLiner = cut(autoSentence(candidate, analysis, verdict), 40)
  return makePick(
    { ...candidate, score: analysis.score, reasons: analysis.reasons },
    { verdict, oneLiner, pickedAt: cfg.now || undefined },
  )
}
