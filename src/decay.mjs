// src/decay.mjs — 互动衰减：三天没互动 → 两天一次；七天没互动 → 停止推荐，直到你回一条。
//
// 「互动」= 你在私信里给登录账号（蓝鲨）发过任何消息（包括分享视频），或点击日报链接不算。
// 判定用北京时间的自然日差，避免时区/跨午夜出错。
//
// 规则（节律见 SPEC）：
//   days <= 3        → normal，每天推荐
//   3 < days <= 7    → low，每两天推荐一次
//   days > 7         → off，暂停推荐（每天仍然会检查，一旦有互动立刻恢复）
// 一旦检测到互动（lastInteractionAt 变化），立即恢复正常节律。
import { beijingParts } from './calendar.mjs'

export const DECAY_RULES = [
  { afterDays: 3, mode: 'low', everyNDays: 2, label: '两天一次' },
  { afterDays: 7, mode: 'off', everyNDays: 0, label: '暂停推荐' },
]

/** 两个时刻之间的北京时间自然日差（b - a） */
export function dayDiff(fromMs, toMs) {
  const a = beijingParts(new Date(fromMs)).dateStr
  const b = beijingParts(new Date(toMs)).dateStr
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  const ams = Date.UTC(ay, am - 1, ad)
  const bms = Date.UTC(by, bm - 1, bd)
  return Math.round((bms - ams) / 86400000)
}

/**
 * 计算当前衰减状态。
 * @param {object} state bili-lite 的 state.json 内容
 * @param {Date} [now]
 * @returns {{mode:'normal'|'low'|'off', everyNDays:number, daysSinceInteraction:number, lastInteractionAt:string|null, reason:string}}
 */
export function computeDecay(state, now = new Date()) {
  const raw = state && state.lastInteractionAt
  if (!raw) {
    return {
      mode: 'normal',
      everyNDays: 1,
      daysSinceInteraction: 0,
      lastInteractionAt: null,
      reason: '还没有互动记录（默认每天推荐；你第一次在私信里回话后就按互动计时）',
    }
  }
  const lastMs = new Date(raw).getTime()
  if (!Number.isFinite(lastMs)) {
    return {
      mode: 'normal',
      everyNDays: 1,
      daysSinceInteraction: 0,
      lastInteractionAt: null,
      reason: '互动时间戳无法解析（按每天推荐处理）',
    }
  }
  const days = Math.max(0, dayDiff(lastMs, now.getTime()))
  let mode = 'normal'
  let everyNDays = 1
  if (days > 7) {
    mode = 'off'
    everyNDays = 0
  } else if (days > 3) {
    mode = 'low'
    everyNDays = 2
  }
  const reason =
    mode === 'normal'
      ? `最近 ${days} 天内有互动，按每天推荐`
      : mode === 'low'
        ? `已经 ${days} 天没互动，降频为每两天推荐一次`
        : `已经 ${days} 天没互动，暂停推荐（你回一句就恢复）`
  return { mode, everyNDays, daysSinceInteraction: days, lastInteractionAt: raw, reason }
}

/**
 * 是否应该在今天推荐。
 * @param {object} decay computeDecay 的返回值
 * @param {string|null} lastShareDay 上次真正推荐（发送成功）的北京日期 YYYY-MM-DD
 * @param {string} todayStr 今天的北京日期
 */
export function shouldShareToday(decay, lastShareDay, todayStr) {
  if (decay.mode === 'off') return { share: false, reason: decay.reason }
  if (decay.everyNDays <= 1) return { share: true, reason: decay.reason }
  if (!lastShareDay) return { share: true, reason: '还没有推荐记录，今天开张' }
  const [y1, m1, d1] = lastShareDay.split('-').map(Number)
  const [y2, m2, d2] = todayStr.split('-').map(Number)
  const gap = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000)
  return {
    share: gap >= decay.everyNDays,
    reason: `距离上次推荐 ${gap} 天，规则是每 ${decay.everyNDays} 天一次`,
    gapDays: gap,
  }
}

/** 记录一次互动（来自 targetUid 的私信） */
export function markInteraction(state, ts, source = 'dm') {
  const ms = Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000
  if (!Number.isFinite(ms)) return state
  const prev = state.lastInteractionAt ? new Date(state.lastInteractionAt).getTime() : 0
  if (ms <= prev) return state
  state.lastInteractionAt = new Date(ms).toISOString()
  state.interactionCount = (Number(state.interactionCount) || 0) + 1
  state.lastInteractionSource = source
  delete state.decayNotifiedAt
  return state
}
