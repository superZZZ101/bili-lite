// src/calendar.mjs — 北京时间 / 中国法定节假日 / DeepSeek 峰谷时段
//
// DeepSeek 官方计费口径（2026-10 现行，api-docs.deepseek.com/zh-cn/quick_start/pricing）：
//   高峰 = 北京时间 周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00
//   空闲 = 其余全部时间（工作日其余时段、周末全天、法定节假日全天），价格按高峰的 50%
// 所以「避开高峰」= 工作日只在这三段跑：[00:00,09:00)、[12:00,14:00)、[18:00,24:00)；
// 周末/节假日全天都可以跑。
//
// 节假日来源：timor.tech 公共 API（type: 0 工作日 / 1 周末 / 2 节假日 / 3 调休补班），
// 结果缓存到 state/holidays.json；API 不可用时保守回退——周末按周末，其余按工作日（避开高峰）。
import fs from 'node:fs'
import path from 'node:path'
import { STATE_DIR, ensureDirs } from './state.mjs'

const API_BASE = 'https://timor.tech/api/holiday/info/'
const CACHE_FILE = path.join(STATE_DIR, 'holidays.json')
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000

/** 工作日高峰时段（分钟表示，[from, to)） */
export const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]
export const PEAK_TEXT = '周一至周五（不含法定节假日）09:00–12:00、14:00–18:00'

const pad = (n) => String(n).padStart(2, '0')

/** 把任意时刻换算成北京时间（UTC+8）的日期与分钟数，避免依赖本机时区设置 */
export function beijingParts(date = new Date()) {
  const bj = new Date(date.getTime() + 8 * 3600 * 1000)
  return {
    dateStr: `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`,
    minutes: bj.getUTCHours() * 60 + bj.getUTCMinutes(),
    hour: bj.getUTCHours(),
    minute: bj.getUTCMinutes(),
    weekday: bj.getUTCDay(), // 0=周日
    tz: 'Asia/Shanghai',
  }
}

/** 分钟数 → HH:MM */
export function fmtMinutes(minutes) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(minutes)))
  if (m === 24 * 60) return '24:00'
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`
}

/** HH:MM → 分钟数 */
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text || '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

function weekdayOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay()
}

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeCache(cache) {
  try {
    ensureDirs()
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8')
  } catch {
    /* 缓存写失败不影响判断 */
  }
}

/**
 * 查询某天的类型。
 * @param {string} dateStr YYYY-MM-DD（北京时间）
 * @returns {Promise<{kind:'workday'|'weekend'|'holiday', name:string, typeCode:number, source:'api'|'fallback', date:string}>}
 */
export async function getDayInfo(dateStr) {
  const cache = readCache()
  const hit = cache[dateStr]
  if (hit && hit.at && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit, date: dateStr }

  try {
    const response = await fetch(`${API_BASE}${dateStr}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    })
    if (response.ok) {
      const json = await response.json()
      if (json && json.code === 0 && json.type) {
        const typeCode = Number(json.type.type)
        const kind = typeCode === 2 ? 'holiday' : typeCode === 1 ? 'weekend' : 'workday'
        const info = {
          kind,
          name: (json.holiday && json.holiday.name) || json.type.name || '',
          typeCode,
          source: 'api',
          at: Date.now(),
        }
        cache[dateStr] = info
        writeCache(cache)
        return { ...info, date: dateStr }
      }
    }
  } catch {
    /* 网络失败走保守回退 */
  }

  const wd = weekdayOf(dateStr)
  const kind = wd === 0 || wd === 6 ? 'weekend' : 'workday'
  return { kind, name: '', typeCode: -1, source: 'fallback', at: 0, date: dateStr }
}

/**
 * 允许运行时段：全天 24 小时。
 * 2026-10-23 用户明确要求「解除 6-22 点内执行任务的限制」，因此不再裁剪清醒时段，
 * 只保留 DeepSeek 峰谷这一层判断（高峰跑贵，但不再禁止）。
 */
export const PREFERRED_WINDOW = { from: 0, to: 24 * 60 }
export const PREFERRED_TEXT = '全天 00:00–24:00'

/** 给定日期类型，返回今天的可运行时段（分钟区间，左闭右开）= DeepSeek 空闲 ∩ 全天 */
export function allowedIntervals(dayInfo) {
  const lo = PREFERRED_WINDOW.from
  const hi = PREFERRED_WINDOW.to
  if (dayInfo && dayInfo.kind === 'workday') {
    // 工作日：避开 09:00–12:00、14:00–18:00 高峰，其余时段全天可跑
    return [
      [lo, 9 * 60],
      [12 * 60, 14 * 60],
      [18 * 60, hi],
    ].filter(([from, to]) => from < to)
  }
  // 周末 / 法定节假日：全天都是空闲
  return [[lo, hi]]
}

/** 该分钟数是否处于 DeepSeek 高峰时段 */
export function isPeak(dayInfo, minutes) {
  if (!dayInfo || dayInfo.kind !== 'workday') return false
  return PEAK_WINDOWS.some(([from, to]) => minutes >= from && minutes < to)
}

/** 该分钟数是否在允许时段内（现已解除 06:00–22:00 限制，全天都算） */
export function isPreferredTime(minutes) {
  return minutes >= PREFERRED_WINDOW.from && minutes < PREFERRED_WINDOW.to
}

/** 从 fromMinutes 起，下一个非高峰时刻（全天找） */
export function nonPeakMinute(dayInfo, fromMinutes) {
  const start = Math.max(0, Math.ceil(fromMinutes / 5) * 5)
  for (let m = start; m < 24 * 60; m += 5) {
    if (!isPeak(dayInfo, m)) return m
  }
  return null
}

/** 从 nowMinutes 起，下一个非高峰时刻（当天；找不到返回 null） */
export function nextAllowedMinute(dayInfo, nowMinutes) {
  const intervals = allowedIntervals(dayInfo)
  for (const [from, to] of intervals) {
    const candidate = Math.max(from, nowMinutes)
    if (candidate < to) return candidate
  }
  return null
}

/**
 * 在允许时段里随机取一个时刻（5 分钟粒度，至少 nowMinutes + minLead）。
 * @returns {{minutes:number, at:string}|null} at 形如 2026-10-22T07:45:00+08:00
 */
export function pickRandomSlot(dayInfo, dateStr, nowMinutes, { minLead = 3, step = 5 } = {}) {
  const intervals = allowedIntervals(dayInfo)
  const slots = []
  for (const [from, to] of intervals) {
    const start = Math.max(from, nowMinutes + minLead)
    for (let m = Math.ceil(start / step) * step; m < to; m += step) slots.push(m)
  }
  if (!slots.length) return null
  const minutes = slots[Math.floor(Math.random() * slots.length)]
  return { minutes, at: `${dateStr}T${fmtMinutes(minutes)}:00+08:00` }
}

/** 给排程用：把一次运行计划写成人能看的一句话 */
export function describePlan({ dayInfo, dateStr, skip, slot, catchup = false }) {
  const dayText =
    dayInfo.kind === 'holiday'
      ? `法定节假日（${dayInfo.name || '节假日'}）`
      : dayInfo.kind === 'weekend'
        ? '周末'
        : `工作日${dayInfo.source === 'fallback' ? '（节假日未验证，按保守处理）' : ''}`
  if (skip) return `${dateStr} ${dayText}：本轮跳过`
  if (!slot) return `${dateStr} ${dayText}：今天没有剩余空闲时段，跳过`
  if (catchup) return `${dateStr} ${dayText}：补跑到 ${fmtMinutes(slot.minutes)}（错过计划，检测到后立刻补）`
  return `${dateStr} ${dayText}：计划 ${fmtMinutes(slot.minutes)} 运行（${PREFERRED_TEXT}，已避开 DeepSeek 高峰 ${PEAK_TEXT}）`
}
