// src/life.mjs — 她自己的生活：低谷期每一小时做一件小事
//
// 设计要点：
//   - 低谷（非 DeepSeek 高峰）每两小时叫醒一次，一次只做一件小事，可以跳过；
//   - 醒来就自己做（不再先规划再执行）；由插件每分钟轮询 `life tick` 触发；
//   - 计划（`life plan`）保留为手动补充，到点照样执行；
//   - 动作（点赞/收藏/关注/取关/投币/动态/追番）看心情，只保留防风控的技术上限；
//   - 她自己不向主人汇报；主人问起来才讲。
import fs from 'node:fs'
import path from 'node:path'

import { STATE_DIR } from './state.mjs'
import { beijingParts, isPeak } from './calendar.mjs'
import { moodText, loadMood, driftMood, adjustMood, isQuiet } from './mood.mjs'
import { recallImpressions, impressionStats } from './impressions.mjs'
import { recentSpeech, renderSpeechBrief } from './speech.mjs'
import { memoryDue, memoryStats } from './memory.mjs'
import { loadState } from './state.mjs'

export const LIFE_FILE = path.join(STATE_DIR, 'life.json')

const CLI_PATH = path.join(import.meta.dirname, 'cli.mjs')
const SKILL_ROOT = path.join(import.meta.dirname, '..')
const STYLE_FILE = path.join(SKILL_ROOT, 'prompts', 'review.md')
const HOME = process.env.BILI_LITE_HOME ? path.resolve(process.env.BILI_LITE_HOME) : SKILL_ROOT

/** 整点后多少分钟内算这一轮的唤醒窗口（插件每分钟轮询，留出重启/休眠的余量） */
export const HOURLY_WINDOW_MINUTES = 20

/** 每隔几个小时醒一次：2 = 每两小时（00/02/04…）；改这里就能调节奏 */
export const LIFE_INTERVAL_HOURS = 2

const REQUEST_COOLDOWN_MS = 30 * 60_000
const AUTO_PLAN_STALE_MS = 3 * 3600_000
const pad = (n) => String(n).padStart(2, '0')

/** 今天的低谷时段：非高峰、且落在整数倍 LIFE_INTERVAL_HOURS 上的整点（周末/节假日整天都算低谷） */
export function lifeHours(dayInfo) {
  const hours = []
  for (let hour = 0; hour < 24; hour += LIFE_INTERVAL_HOURS) {
    if (isPeak(dayInfo, hour * 60)) continue
    hours.push({ key: pad(hour), hour, minutes: hour * 60, label: `${pad(hour)}:00` })
  }
  return hours
}

/**
 * 刷视频（生活回合）的会话 id：**一天一个对话**。
 * 2026-10-26 用户要求：不再每轮/按上下文换新会话，一整天都在同一个对话里，
 * 日记路径（公开/私密）每轮都随提示词给她，她自己 read。
 */
export function lifeSessionId(now = new Date()) {
  const base = process.env.BILI_LITE_LIFE_SESSION || 'bili-lite-life'
  return `${base}-${beijingParts(now).dateStr}`
}

const ACTION_CAPS = {
  like: null,
  fav: null,
  follow: null,
  unfollow: null,
  coin: 5,
  dynamic: 3,
  comment: 0,
  bangumi: 1,
  proactive: 10,
}

function capText(cap) {
  return cap === null || cap === undefined ? '不限' : cap
}

function fileOf(opts = {}) {
  return opts.file || LIFE_FILE
}

function emptyState() {
  return {
    version: 2,
    plans: [],
    requests: {},
    hours: {},
    lastTickAt: null,
    lastPlanCycle: {},
    counters: { day: '', likes: 0, favs: 0, follows: 0, unfollows: 0, coins: 0, dynamics: 0, comments: 0, bangumiMonth: '', bangumi: 0, proactive: 0 },
  }
}

export function loadLife(opts = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(opts), 'utf8'))
    if (!raw || typeof raw !== 'object') return emptyState()
    return {
      ...emptyState(),
      ...raw,
      plans: Array.isArray(raw.plans) ? raw.plans : [],
      requests: raw.requests && typeof raw.requests === 'object' ? raw.requests : {},
      hours: raw.hours && typeof raw.hours === 'object' ? raw.hours : {},
      counters: { ...emptyState().counters, ...(raw.counters || {}) },
    }
  } catch {
    return emptyState()
  }
}

export function saveLife(state, opts = {}) {
  const file = fileOf(opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return state
}

/** 用北京时间算“她的今天”：18:00 → 次日 18:00；02:00 属于前一天的周期 */
export function cycleOf(now = new Date()) {
  const parts = beijingParts(now)
  if (parts.minutes < 18 * 60) {
    const [year, month, day] = parts.dateStr.split('-').map(Number)
    const prev = new Date(Date.UTC(year, month - 1, day - 1))
    return prev.toISOString().slice(0, 10)
  }
  return parts.dateStr
}

function todayKey(now = new Date()) {
  return beijingParts(now).dateStr
}

function monthKey(now = new Date()) {
  return beijingParts(now).dateStr.slice(0, 7)
}

function ensureCounters(state, now = new Date()) {
  const day = todayKey(now)
  if (state.counters.day !== day) {
    state.counters = { ...emptyState().counters, day, bangumiMonth: monthKey(now) }
  }
  if (state.counters.bangumiMonth !== monthKey(now)) {
    state.counters.bangumiMonth = monthKey(now)
    state.counters.bangumi = 0
  }
  return state.counters
}

function prune(state, now = new Date()) {
  const cutoff = now.getTime() - 30 * 86400_000
  for (const [key, at] of Object.entries(state.requests || {})) {
    if (!at || new Date(at).getTime() < cutoff) delete state.requests[key]
  }
  // 每小时活动的打卡只留最近 7 天
  const hourCutoff = beijingParts(new Date(now.getTime() - 7 * 86400_000)).dateStr
  for (const date of Object.keys(state.hours || {})) {
    if (date < hourCutoff) delete state.hours[date]
  }
  state.plans = (state.plans || []).filter((plan) => {
    if (['done', 'skipped', 'cancelled', 'missed'].includes(plan.status)) {
      const finishedAt = new Date(plan.finishedAt || plan.at || plan.createdAt).getTime()
      // 每小时活动一天二十来条，只留 7 天；手写计划留 60 天
      return now.getTime() - finishedAt < (plan.auto ? 7 : 60) * 86400_000
    }
    return true
  })
}

function wasRequested(state, key, now = new Date()) {
  const at = state.requests[key]
  if (!at) return false
  return now.getTime() - new Date(at).getTime() < REQUEST_COOLDOWN_MS
}

function markRequested(state, key, now = new Date()) {
  state.requests[key] = now.toISOString()
}

/** 到点/到整点时，问一下现在该不该叫醒她 */
export function lifeTick({ now = new Date(), dayInfo, peak, file } = {}) {
  const state = loadLife({ file })
  prune(state, now)
  ensureCounters(state, now)
  const parts = beijingParts(now)
  const cycle = cycleOf(now)
  const today = parts.dateStr
  const isPeakNow = peak !== undefined ? Boolean(peak) : Boolean(dayInfo && isPeak(dayInfo, parts.minutes))
  const base = {
    now: now.toISOString(),
    cycle,
    minutes: parts.minutes,
    peak: isPeakNow,
    sessionId: lifeSessionId(now),
  }

  if (isPeakNow) {
    state.lastTickAt = now.toISOString()
    saveLife(state, { file })
    return { ...base, action: 'none', reason: 'peak' }
  }

  // 0) 清理没做完的活动：手动计划 30 分钟后放回 scheduled 重试；每小时活动 3 小时后记为 missed
  for (const plan of state.plans || []) {
    if (plan.status !== 'requested' || !plan.requestedAt) continue
    const age = now.getTime() - new Date(plan.requestedAt).getTime()
    if (plan.auto) {
      if (age > AUTO_PLAN_STALE_MS) plan.status = 'missed'
    } else if (age > 30 * 60_000) {
      plan.status = 'scheduled'
    }
  }

  // 1) 月度整理：1 号 02:00 窗口优先（算这一小时的活动）
  if (parts.hour === 2 && parts.minute < HOURLY_WINDOW_MINUTES) {
    const due = memoryDue({ now })
    if (due.due) {
      const key = `memory-${due.suggestedMonth}`
      if (!wasRequested(state, key, now)) {
        markRequested(state, key, now)
        markHour(state, today, '02')
        state.lastTickAt = now.toISOString()
        saveLife(state, { file })
        return { ...base, action: 'memory', month: due.suggestedMonth, prompt: memoryPrompt(due.suggestedMonth, now) }
      }
    }
  }

  // 2) 手动写下的计划：到点执行（这一小时就只做它）
  const duePlans = (state.plans || [])
    .filter((plan) => plan.status === 'scheduled' && new Date(plan.at).getTime() <= now.getTime() + 60_000)
    .sort((a, b) => new Date(a.at) - new Date(b.at))
  if (duePlans.length) {
    const plan = duePlans[0]
    const key = `exec-${plan.id}`
    if (!wasRequested(state, key, now)) {
      markRequested(state, key, now)
      plan.status = 'requested'
      plan.requestedAt = now.toISOString()
      markHour(state, today, pad(parts.hour))
      state.lastTickAt = now.toISOString()
      saveLife(state, { file })
      return { ...base, action: 'execute', plan, prompt: executePrompt(plan, { now, file }) }
    }
  }

  // 3) 低谷期每两小时醒一次：做一件小事（这一轮已经排了手写计划就让它做，不重复叫）
  const hour = lifeHours(dayInfo || { kind: 'weekend' }).find(
    (item) => parts.minutes >= item.minutes && parts.minutes < item.minutes + HOURLY_WINDOW_MINUTES,
  )
  if (hour && !hourDone(state, today, hour.key) && !planInHour(state, today, hour.key)) {
    markHour(state, today, hour.key)
    const plan = createHourlyPlan(state, { cycle, now, hour })
    state.lastTickAt = now.toISOString()
    saveLife(state, { file })
    return { ...base, action: 'act', slot: hour.key, plan, prompt: actPrompt(plan, { now, file }) }
  }

  state.lastTickAt = now.toISOString()
  saveLife(state, { file })
  return { ...base, action: 'none' }
}

function hourDone(state, dateStr, key) {
  const list = state.hours && state.hours[dateStr]
  return Array.isArray(list) && list.includes(key)
}

/** 这一小时里已经排了手写计划（还没执行）→ 让计划当这一小时的活动 */
function planInHour(state, dateStr, hourKey) {
  const start = new Date(`${dateStr}T${hourKey}:00:00+08:00`).getTime()
  const end = start + 3600_000
  return (state.plans || []).some((plan) => {
    if (plan.status !== 'scheduled') return false
    const at = new Date(plan.at).getTime()
    return at >= start && at < end
  })
}

function markHour(state, dateStr, key) {
  if (!state.hours || typeof state.hours !== 'object') state.hours = {}
  const list = Array.isArray(state.hours[dateStr]) ? state.hours[dateStr] : []
  if (!list.includes(key)) list.push(key)
  state.hours[dateStr] = list
}

/** 每小时活动先落一条 auto 计划，`life finish --id` 才有东西可收尾 */
function createHourlyPlan(state, { cycle, now, hour }) {
  const plan = {
    id: `life-${cycle}-${hour.key}-${Math.random().toString(36).slice(2, 6)}`,
    cycle,
    slot: hour.key,
    auto: true,
    createdAt: now.toISOString(),
    intent: '',
    activity: 'any',
    target: '',
    at: `${beijingParts(now).dateStr}T${hour.label}:00+08:00`,
    status: 'requested',
    requestedAt: now.toISOString(),
    finishedAt: null,
    result: '',
    mood: String(loadMood().label || ''),
  }
  state.plans.push(plan)
  return plan
}

/** 写一条计划；at 用 HH:MM（北京时间），必须非高峰；不给 slot 就按 at 的小时算 */
export function addPlan({ slot, intent, activity = 'watch', at, target = '', now = new Date(), dayInfo, file } = {}) {
  const parts = beijingParts(now)
  const minute = parseAt(at, parts.minutes)
  if (minute == null) throw new Error('--at 需要 HH:MM（北京时间）')
  const slotKey = slot === undefined || slot === null || slot === '' ? pad(Math.floor(minute / 60)) : normalizeSlotKey(slot)
  if (!slotKey) throw new Error(`未知的生活场次：${slot}（只能是 00–23 的整点小时）`)
  if (dayInfo && isPeak(dayInfo, minute)) throw new Error(`--at ${at} 在 DeepSeek 高峰，换一个非高峰时间`)
  // 比现在晚就今天，比现在早就是明天（例如 23:00 规划 02:00）
  const targetDate = minute > parts.minutes ? parts.dateStr : addDays(parts.dateStr, 1)
  const atIso = `${targetDate}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00+08:00`
  if (new Date(atIso).getTime() <= now.getTime() + 60_000) throw new Error('--at 需要晚于现在（至少 1 分钟后）')
  const cycle = cycleOf(new Date(atIso))
  const state = loadLife({ file })
  ensureCounters(state, now)
  const plan = {
    id: `life-${cycle}-${slotKey}-${Math.random().toString(36).slice(2, 6)}`,
    cycle,
    slot: slotKey,
    auto: false,
    createdAt: now.toISOString(),
    intent: String(intent || '').slice(0, 500),
    activity: String(activity || 'watch'),
    target: String(target || '').slice(0, 200),
    at: atIso,
    status: 'scheduled',
    requestedAt: null,
    finishedAt: null,
    result: '',
    mood: String(loadMood().label || ''),
  }
  // 同一个 cycle+slot 只留一条手动计划；新计划替换旧的未执行计划
  state.plans = (state.plans || []).filter(
    (item) => !(item.auto !== true && item.cycle === cycle && item.slot === slotKey && item.status === 'scheduled'),
  )
  state.plans.push(plan)
  saveLife(state, { file })
  return plan
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00+08:00`)
  date.setUTCDate(date.getUTCDate() + days)
  return new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 10)
}

/** '9' / '09' / '18' → '09' / '18'；不合法返回空串 */
function normalizeSlotKey(raw) {
  const text = String(raw ?? '').trim()
  if (!/^\d{1,2}$/.test(text)) return ''
  const hour = Number(text)
  if (hour > 23) return ''
  return pad(hour)
}

function parseAt(at, nowMinutes) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(at || '').trim())
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

/** 收尾：标完成 + 顺带把心情往 0.5 漂一点（她自己的生活也该让她慢慢变） */
export function finishPlan(id, { result = '', status = 'done', now = new Date(), file, withDrift = true } = {}) {
  const state = loadLife({ file })
  const plan = (state.plans || []).find((item) => item.id === id)
  if (!plan) return { ok: false, error: `找不到计划 ${id}` }
  plan.status = status
  plan.result = String(result || '').slice(0, 1000)
  plan.finishedAt = now.toISOString()
  saveLife(state, { file })
  let mood = null
  if (withDrift) {
    try {
      // driftMood 6 小时内不重复漂，所以不会每次收尾都变
      mood = driftMood(loadMood(), { now })
    } catch {
      /* 漂移失败不影响收尾 */
    }
  }
  return { ok: true, plan, mood }
}

export function skipPlan(id, { now = new Date(), file } = {}) {
  return finishPlan(id, { status: 'skipped', result: '今天什么都不做', now, file })
}
export function currentPlan({ now = new Date(), file } = {}) {
  const state = loadLife({ file })
  const plans = (state.plans || []).filter((plan) => ['scheduled', 'requested'].includes(plan.status))
  plans.sort((a, b) => new Date(a.at) - new Date(b.at))
  return plans[0] || null
}

/** 技术护栏：只防刷屏/风控，不替代心情 */
export function canAct(type, { now = new Date(), coins = null, file } = {}) {
  const state = loadLife({ file })
  const counters = ensureCounters(state, now)
  const cap = ACTION_CAPS[type]
  const used =
    type === 'like'
      ? counters.likes
      : type === 'fav'
        ? counters.favs
        : type === 'follow'
          ? counters.follows
          : type === 'unfollow'
            ? counters.unfollows
            : type === 'coin'
              ? counters.coins
              : type === 'dynamic'
                ? counters.dynamics
                : type === 'comment'
                  ? counters.comments
                  : type === 'bangumi'
                  ? counters.bangumi
                  : type === 'proactive'
                    ? counters.proactive
                    : 0
  if (type === 'coin' && coins !== null && Number(coins) <= 0) {
    return { ok: false, reason: '没有硬币了', cap, used }
  }
  if (cap === null || cap === undefined) return { ok: true, cap: null, used }
  return { ok: used < cap, reason: used >= cap ? `今天/这个月的 ${type} 先到这儿吧` : '', cap, used }
}

export function noteAction(type, { now = new Date(), file } = {}) {  const state = loadLife({ file })
  const counters = ensureCounters(state, now)
  const map = {
    like: 'likes',
    fav: 'favs',
    follow: 'follows',
    unfollow: 'unfollows',
    coin: 'coins',
    dynamic: 'dynamics',
    comment: 'comments',
    bangumi: 'bangumi',
    proactive: 'proactive',
  }
  const field = map[type]
  if (field) counters[field] = Number(counters[field] || 0) + 1
  saveLife(state, { file })
  return counters
}

/** 给生活任务/回复用的状态：心情 + 最近印象 + 最近说过 + 计数 + 当前计划 */
export function lifeContext({ now = new Date(), file } = {}) {
  const mood = driftMood(loadMood(), { now })
  const impressions = recallImpressions({ limit: 3, mood: mood.label })
  const speech = recentSpeech({ channels: ['dm-owner', 'proactive', 'comment'], limit: 3 })
  const state = loadLife({ file })
  const counters = ensureCounters(state, now)
  return {
    now: now.toISOString(),
    cycle: cycleOf(now),
    mood,
    quiet: isQuiet(mood),
    impressions,
    speech: renderSpeechBrief({ channels: ['dm-owner', 'proactive', 'comment'], limit: 3 }),
    recent: speech.map((item) => item.text),
    plan: currentPlan({ now, file }),
    counters: { ...counters },
    memory: memoryStats(),
  }
}

/** 两本日记的文件地址（不把正文塞进提示词，让她自己 read）。 */
function diaryPaths() {
  const dir = process.env.BILI_LITE_DIARY_DIR || path.join(HOME, 'diary')
  const publicDiary = path.join(dir, 'public.md')
  const privateDiary = path.join(dir, 'private.md')
  return [
    '【日记（写之前自己 read，别整段抄进回复）】',
    `公开：${publicDiary}（主人可以看）`,
    `私密：${privateDiary}（只有你自己看）`,
  ].join('\n')
}

function commonContext({ now, file } = {}) {
  const context = lifeContext({ now, file })
  return [
    moodText(context.mood),
    '',
    `【今天的技术计数】点赞 ${context.counters.likes}/${capText(ACTION_CAPS.like)}、收藏 ${context.counters.favs}/${capText(ACTION_CAPS.fav)}、关注 ${context.counters.follows}/${capText(ACTION_CAPS.follow)}、取关 ${context.counters.unfollows}/${capText(ACTION_CAPS.unfollow)}、投币 ${context.counters.coins}/${capText(ACTION_CAPS.coin)}、动态 ${context.counters.dynamics}/${capText(ACTION_CAPS.dynamic)}、评论 停用、追番 ${context.counters.bangumi}/${capText(ACTION_CAPS.bangumi)}`,
    context.plan ? `【当前计划】${context.plan.at} · ${context.plan.intent || '（这一次的活动）'}` : '【当前计划】没有',
    context.memory && context.memory.summary ? `【月度记忆】${context.memory.summary}` : '',
    diaryPaths(),
  ]
    .filter(Boolean)
    .join('\n')
}

/** 生活回合的稳定前缀行：人设原文 + 环境（每轮都一模一样，放最前面给前缀缓存复用） */
function lifeBaseLines() {
  let persona = ''
  try {
    const personaFile = loadState().config?.reviewPromptPath || STYLE_FILE
    persona = fs.existsSync(personaFile) ? fs.readFileSync(personaFile, 'utf8').trim() : ''
  } catch {
    persona = ''
  }
  return [
    ...(persona ? ['【人设 · 唯一真源 prompts/review.md】', persona, ''] : []),
    '【环境】',
    `每条命令前：$env:BILI_LITE_HOME='${HOME}'`,
    `$env:BILI_LITE_NO_WRITE='1'`,
    `CLI：node "${CLI_PATH}"`,
    '',
  ]
}

/** 低谷每两小时一次的「这一次」提示词：醒来就自己做，不再先规划再执行 */
export function actPrompt(plan, { now = new Date(), file } = {}) {
  const cli = `node "${CLI_PATH}"`
  const parts = beijingParts(now)
  const hourLabel = `${plan.slot}:00`
  return [
    // ── 稳定段：几乎永远不变，放最前面，方便命中前缀缓存 ──
    // 刷视频一整天都在同一个会话里（见 lifeSessionId），所以这段是「每次都在同一位置」的人设+环境
    ...lifeBaseLines(),
    '【bili-lite 生活 · 这一次】',
    `【同一个对话】今天一直在这个对话里（${lifeSessionId(now)}），前面几轮做过的事、读过的日记都还在；`
      + '接着往下过就行，不用重新认识主人，也不用把同一件事再做一遍。',
    '【日记路径】下面【日记】段里给了公开/私密两本的固定路径（今天不会变），写之前先 read。',
    `【环境】每条命令前：$env:BILI_LITE_HOME='${HOME}'`,
    `【口吻】按 "${STYLE_FILE}" 的小蓝鲸；生活任务不用汇报行程，想分享就说。`,
    '',
    '【这一次】低谷期每两小时只醒一次（整点 00/02/04…），做一件小事就够：',
    '- 可以刷几条推荐（最多 8 条）记 1~3 个印象，也可以只做一件互动：点赞/收藏/关注/取关/投币/追番/发动态。',
    '- 上下文里的“你”指这个会话的主人，但**这一段不是回他、也不算跟他汇报**：',
    '  做的事留在记忆里（印象/日记）；想分享时用 `life say` 主动说一两句，别用 `reply` 往主人私信发东西。',
    '- **心情可以由你自己调**：看完/聊完真被戳到，就 `mood adjust`（单次每轴 ≤0.15、一小时合计 0.25、一天 0.5，'
      + '同来源 10 分钟冷却，写 --why 和 --source）；没有明显情绪就别调，也别靠标题/评论关键词判断。',
    '- **评论功能已停用（2026-10-26 起）**：不要发评论、不要回复别人的评论；只看不评，评论区当只读。',
    '- **想发动态就发**：`life action dynamic --text "..."`（每天最多 3 条）；刷到/想到什么就直接发，不用攒着，也不用配图。'
      + '说到某条视频就把链接直接写进 `--text`（`https://www.bilibili.com/video/BV...`），最省事。',
    '- 写感悟/日记前先 read 下面【日记】里的两本路径，能接上就接，别把同一件事再写一遍；'
      + '写日记提到某条视频时带 `--bvid BV...`，会自动把链接写进日记。',
    '- 一次只做一件；别每次都重复同一件事，也别为了做而做。',
    '- **技术上限是内部护栏**（心情调整、动态/主动私信次数）：不要跟主人说“额度/上限/还剩几次”，'
      + '被拦下就收住，不解释、不报数字。',
    '- 收尾不要把“这一轮结束啦/已分享/额度…”写成给主人看的总结；收尾只是把计划标成完成。',
    '- 真不想动就跳过这一次（`life finish --id <id> --status skipped`），不用勉强。',
    '- 不要发“今天计划/做了什么”这类汇报；分享就说分享的话。',
    '',
    ...lifeCommandLines(cli, plan),
    '',
    // ── 变动段：时间/心情/计数/最近记忆，每轮都不一样，放最后 ──
    `【那一次是什么时候】${parts.dateStr} ${pad(parts.hour)}:${pad(parts.minute)}（她的今天：${plan.cycle}）`,
    '【现在的心情】（这一项每轮都会变）',
    commonContext({ now, file }),
    '',
    '【想分享就分享】刷到/想到想让主人知道的（一条视频、一个想法、今天的一件小事），'
      + '就用 `life say --text "..."` 跟他说一两句；像分享，不像汇报，不列数量/行程。'
      + '分享视频时带上链接（`https://www.bilibili.com/video/BV号`，`life recall` 里能找到），不要只说标题。'
      + '没有想说的就跳过。',
    '',
    `${cli} life finish --id ${plan.id} --result "..."`,
    '做完这一件就收尾（收尾是指把计划标成完成，不是给主人发消息，也不写给主人看的总结），下一轮再醒。',
  ].join('\n')
}

export function executePrompt(plan, { now = new Date(), file } = {}) {
  const cli = `node "${CLI_PATH}"`
  return [
    // ── 稳定段 ──
    ...lifeBaseLines(),
    `【bili-lite 生活 · 执行】`,
    `【口吻】不向主人汇报。`,
    '',
    '【现在去做】',
    `【同一个对话】今天一直在这个对话里（${lifeSessionId(now)}），前面的回合还在；接着往下做，别重复。`,
    '【日记路径】下面【日记】段里给了公开/私密两本的固定路径（今天不会变），写之前先 read。',
    '- 上下文里的“你”指这个会话的主人，但这一段不是回他、也不算跟他汇报；做的事留在记忆里，他问起来才讲。',
    '- 最多刷 8 条；记 1~3 个印象（`impressions add`），不要每条都记。',
    '- 真想看画面：`frames --bvid BV... --no-vision`（约 16 秒，默认 1.2 帧/秒、约 0.83 秒一格，张数不限）；'
      + '**`read_image` 想看几张看几张**（DeepSeek 这条线能看图，比本地 Qwen 快）；没看清就说没看清，别编。'
      + '`frames --vision-only` 只作本地 Qwen 对照。每场最多看 2 个视频。',
    '- 看心情点赞/收藏/关注/取关/投币/发动态（评论已停用）；技术上限只防刷屏。',
    '- **想发动态就发**：`life action dynamic --text "..."`（每天最多 3 条）；刷到/想到什么就直接发，不用攒着。'
      + '说到某条视频就把链接直接写进 `--text`（`https://www.bilibili.com/video/BV...`），最省事。',
    '- 写感悟/日记前先 read 下面【日记】里的两本路径，能接上就接，别把同一件事再写一遍；'
      + '写日记提到某条视频时带 `--bvid BV...`，会自动把链接写进日记。',
    '- **心情可以由你自己调**：看完/聊完真被戳到，就 `mood adjust`（单次每轴 ≤0.15、一小时合计 0.25、一天 0.5，写 --why 和 --source）：',
    `  ${cli} mood adjust --warmth +0.1 --talk -0.05 --blend "累,想被夸" --why "..." --source life:video`,
    '  不要根据标题/评论关键词判断；没有明显情绪就不调。mood set 只用于明确的整体状态，别绕过上限。',
    '- 做完 `life finish --id <id> --result "..."`；如果不想做了就 `life finish --id <id> --status skipped`。',
    '- 不要向主人汇报；她自己的生活不需要交作业。',
    '',
    ...lifeCommandLines(cli, plan),
    '',
    // ── 变动段 ──
    `【这次要做的】${plan.intent || '（没写）'}`,
    `【时间/活动】${plan.at}｜${plan.activity}${plan.target ? `｜目标：${plan.target}` : ''}`,
    '【现在的心情】（这一项每轮都会变）',
    commonContext({ now, file }),
    '',
    `${cli} life finish --id ${plan.id} --result "..."`,
  ].join('\n')
}

/** 生活回合可用的命令清单 */
function lifeCommandLines(cli, plan) {
  return [
    `${cli} life context`,
    `${cli} life recall --topic "..."（想回忆之前记下的东西时）`,
    `${cli} scan --limit 8`,
    `${cli} frames --bvid BV... --no-vision [--count 4] [--sparse] [--fps 0.63]（默认 1.2 帧/秒；抽完立刻返回）`,
    `${cli} frames --vision-only --bvid BV...（每次 2 张，重复到 remaining=0）`,
    `${cli} frames --vision-status --bvid BV...（读已完成的识图文本）`,
    `${cli} impressions add --title "..." --author "..." --content "..." --comment "..." --why "..." [--bvid BV...]`,
    `${cli} mood adjust --warmth +0.1 --talk -0.05 --blend "累,想被夸" --why "..." --source life:video`,
    `${cli} life action like|fav|coin|follow|unfollow|bangumi --bvid BV... [--mid 123] [--season 123]`,
    `${cli} life action dynamic --text "..." [--image "C:\\path\\frame.png"]`,
    `${cli} comments list [--limit 20]（只读历史评论台账，评论功能已停用）`,
    `${cli} diary add --text "..." [--private] [--bvid BV...]（写日记；提到视频就带 bvid，自动加链接）`,
    `${cli} life say --text "..."`,
    `计划 id（收尾用）：${plan.id}`,
  ]
}

export function memoryPrompt(month, now = new Date()) {
  const cli = `node "${CLI_PATH}"`
  return [
    '【bili-lite 生活 · 整理记忆】',
    `这个月（${month}）要留下 63%，其余忘掉。`,
    `【环境】每条命令前：$env:BILI_LITE_HOME='${HOME}'`,
    '',
    '步骤：',
    `1) ${cli} memory plan --month ${month}（看清单，每类保留约 63%）`,
    '2) 写一段这个月的总结（gist 记忆），几句就够。',
    '3) 选要留下的 id（每类约 63%，至少留 1/6 给普通记忆；pinned 和最近 7 天自动留下）。',
    `4) ${cli} memory consolidate --month ${month} --summary "..." --keep "id1,id2,..."`,
    '不要向主人汇报；忘掉的就忘掉。',
  ].join('\n')
}

export function lifeStats({ now = new Date(), file } = {}) {
  const state = loadLife({ file })
  const counters = ensureCounters(state, now)
  const today = beijingParts(now).dateStr
  return {
    cycle: cycleOf(now),
    sessionId: lifeSessionId(now),
    hoursToday: Array.isArray(state.hours && state.hours[today]) ? state.hours[today] : [],
    plans: (state.plans || []).slice(-10).map((plan) => ({
      id: plan.id,
      cycle: plan.cycle,
      slot: plan.slot,
      auto: Boolean(plan.auto),
      at: plan.at,
      status: plan.status,
      intent: plan.intent,
    })),
    counters: { ...counters },
    caps: ACTION_CAPS,
    file: fileOf({ file }),
    mood: loadMood().label,
    impressions: impressionStats(),
  }
}
