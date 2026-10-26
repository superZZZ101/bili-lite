// src/memory.mjs — 每月整理记忆：保留 63%，其余遗忘
//
// 规则（2026-10-23 用户定）：
//   - 每月一次，由她自己选 63% 留下，37% 从她那边消失；
//   - 按类分别算：公开日记 / 私密日记 / 印象 / 发言记录，各留 63%；
//   - 最近 7 天、pinned（最多 10 条）不参与遗忘；
//   - 忘掉的内容进「主人可查、她不可读」的归档；公开动作只留 stub；
//   - 月度总结永远保留（gist 记忆）。
import fs from 'node:fs'
import path from 'node:path'

import { STATE_DIR } from './state.mjs'
import { readEntries, parseDiary, diaryFile } from './diary.mjs'
import { loadImpressions, saveImpressions } from './impressions.mjs'
import { readSpeech } from './speech.mjs'

export const MEMORY_DIR = path.join(STATE_DIR, 'memory-archive')
export const META_FILE = path.join(STATE_DIR, 'memory-meta.json')
export const PIN_FILE = path.join(STATE_DIR, 'memory-pins.json')
export const SUMMARY_FILE = path.join(STATE_DIR, 'memory-summary.md')
export const STUBS_FILE = path.join(STATE_DIR, 'public-stubs.json')

const KEEP_RATIO = 0.63
const RECENT_DAYS = 7
const MAX_PINS = 10
const MIN_ELIGIBLE = 10

const CATEGORIES = ['diary-public', 'diary-private', 'impressions', 'speech']

function fileOr(opts, key, fallback) {
  return (opts && opts[key]) || fallback
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function stampToIso(stamp) {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(String(stamp || ''))
  if (!match) return ''
  return `${match[1]}T${match[2]}:${match[3]}:00+08:00`
}

function monthOf(iso) {
  const text = String(iso || '')
  if (/^\d{4}-\d{2}/.test(text)) return text.slice(0, 7)
  return ''
}

/** 给日记条目一个不含空格/逗号的短 id（--keep 用逗号分隔） */
function shortHash(text) {
  let hash = 2166136261
  for (const char of String(text || '')) {
    hash ^= char.codePointAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function diaryId(scope, entry, index) {
  return `d:${scope}:${String(entry.stamp || '').replace(/\s+/g, 'T')}:${shortHash(entry.title)}:${index}`
}

export function previousMonth(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 3600_000)
  const year = bj.getUTCFullYear()
  const month = bj.getUTCMonth() // 0-based
  const prev = new Date(Date.UTC(year, month - 1, 1))
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`
}

export function loadPins({ file } = {}) {
  const data = readJson(file || PIN_FILE, { ids: [] })
  return Array.isArray(data.ids) ? data.ids.map(String) : []
}

export function savePins(ids, { file } = {}) {
  const unique = [...new Set(ids.map(String))].slice(0, MAX_PINS)
  writeJson(file || PIN_FILE, { ids: unique })
  return unique
}

export function pinMemory(id, pinned = true, { file } = {}) {
  const ids = loadPins({ file })
  const next = pinned ? [...ids, String(id)] : ids.filter((item) => item !== String(id))
  if (pinned && !ids.includes(String(id)) && ids.length >= MAX_PINS) {
    return { ok: false, error: `最多 pin ${MAX_PINS} 条，先 unpin 一条` }
  }
  savePins(next, { file })
  return { ok: true, ids: next }
}

export function addPublicStub({ type, note = '', at = new Date().toISOString() }, { file } = {}) {
  const target = file || STUBS_FILE
  const data = readJson(target, { items: [] })
  data.items = Array.isArray(data.items) ? data.items : []
  data.items.push({ at, type: String(type || 'action'), note: String(note || '') })
  data.items = data.items.slice(-500)
  writeJson(target, data)
  return data.items[data.items.length - 1]
}

export function loadMeta({ file } = {}) {
  return readJson(file || META_FILE, { version: 1, lastConsolidatedAt: null, lastMonth: '', stats: null })
}

function saveMeta(meta, { file } = {}) {
  writeJson(file || META_FILE, meta)
}

/**
 * 这个月该不该整理：每月 1 号 02:00 后，或距上次超过 35 天。
 *
 * 2026-10-26 修：以前「第一次整理」要求「有 35 天以上的旧记忆」，
 * 结果 11-01 到了却因为最早的记忆才 9 天而整月跳过 → 第一次遗忘被推到 12-01，10 月的记忆再也没整理过。
 * 现在改成：第一次只看「有没有上一个月的记忆」——有就在 1 号整理，并且允许错过 1 号后补跑一次。
 */
export function memoryDue({ now = new Date(), metaFile, diaryDir, impressionsFile, speechFile, pinFile } = {}) {
  const meta = loadMeta({ file: metaFile })
  const last = meta.lastConsolidatedAt ? new Date(meta.lastConsolidatedAt) : null
  const bj = new Date(now.getTime() + 8 * 3600_000)
  const day = bj.getUTCDate()
  const hour = bj.getUTCHours()
  if (!last) {
    // 第一次：1 号 02:00 之后，只要上个月确实有记忆就整理（不看 35 天）
    const month = previousMonth(now)
    const hasPrev = collectEntries({ month, includeRecent: true, diaryDir, impressionsFile, speechFile, pinFile }).length > 0
    return {
      due: day >= 1 && hour >= 2 && hasPrev,
      reason: hasPrev ? 'first-monthly' : 'no-old-memory',
      suggestedMonth: month,
      lastConsolidatedAt: null,
    }
  }
  const days = (now.getTime() - last.getTime()) / 86400_000
  const lastMonthKey = new Date(last.getTime() + 8 * 3600_000).toISOString().slice(0, 7)
  const prev = previousMonth(now)
  return {
    due: days >= 35 || (day === 1 && hour >= 2 && lastMonthKey !== prev),
    reason: days >= 35 ? 'overdue' : 'monthly',
    suggestedMonth: prev,
    lastConsolidatedAt: meta.lastConsolidatedAt,
  }
}

function oldestEntryAt() {
  const entries = collectEntries({ month: null, includeRecent: true })
  if (!entries.length) return null
  return entries.map((entry) => entry.at).sort()[0]
}

/** 上个月到现在有没有「该遗忘但还没整理」的记忆（给 status 用） */
export function pendingMonth({ now = new Date(), diaryDir, impressionsFile, speechFile, pinFile } = {}) {
  const month = previousMonth(now)
  return {
    month,
    entries: collectEntries({ month, includeRecent: true, diaryDir, impressionsFile, speechFile, pinFile }).length,
  }
}

/**
 * 收集某个月（或全部）的记忆条目。
 * @param {{month?:string|null, now?:Date, diaryDir?:string, impressionsFile?:string, speechFile?:string, includeRecent?:boolean}} opts
 */
export function collectEntries({
  month,
  now = new Date(),
  diaryDir,
  impressionsFile,
  speechFile,
  pinFile,
  includeRecent = true,
} = {}) {
  const entries = []
  const pins = loadPins({ file: pinFile })
  const recentCutoff = now.getTime() - RECENT_DAYS * 86400_000

  for (const scope of ['public', 'private']) {
    const category = `diary-${scope}`
    // 文件不存在就不要 readEntries（它会 ensure 出新文件，测试/只读场景会污染目录）
    if (!fs.existsSync(diaryFile(scope, { dir: diaryDir }))) continue
    const list = readEntries(scope, { dir: diaryDir })
    list.forEach((entry, index) => {
      const at = stampToIso(entry.stamp)
      if (!at) return
      if (month && monthOf(at) !== month) return
      const age = now.getTime() - new Date(at).getTime()
      if (!includeRecent && age < RECENT_DAYS * 86400_000) return
      const id = diaryId(scope, entry, index)
      entries.push({
        id,
        category,
        scope,
        at,
        stamp: entry.stamp,
        title: entry.title,
        text: entry.body,
        raw: entry.raw,
        pinned: pins.includes(id),
        recent: age < RECENT_DAYS * 86400_000,
        index,
      })
    })
  }

  const impressions = loadImpressions({ file: impressionsFile })
  for (const item of impressions) {
    const at = new Date(item.at).toISOString()
    if (!at || Number.isNaN(new Date(at).getTime())) continue
    if (month && monthOf(at) !== month) continue
    const age = now.getTime() - new Date(at).getTime()
    if (!includeRecent && age < RECENT_DAYS * 86400_000) continue
    const id = `i:${item.id}`
    entries.push({
      id,
      category: 'impressions',
      at,
      title: item.title,
      text: [item.title, item.content, item.comment, item.why].filter(Boolean).join(' / '),
      item,
      pinned: Boolean(item.pinned) || pins.includes(id),
      recent: age < RECENT_DAYS * 86400_000,
    })
  }

  const speech = readSpeech({ file: speechFile })
  for (const item of speech) {
    const at = new Date(item.at).toISOString()
    if (!at || Number.isNaN(new Date(at).getTime())) continue
    if (month && monthOf(at) !== month) continue
    const age = now.getTime() - new Date(at).getTime()
    if (!includeRecent && age < RECENT_DAYS * 86400_000) continue
    const id = `s:${item.id}`
    entries.push({
      id,
      category: 'speech',
      at,
      title: item.channel,
      text: item.text,
      item,
      pinned: pins.includes(id),
      recent: age < RECENT_DAYS * 86400_000,
    })
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at))
}

/** 整理清单：给 agent 看的紧凑版（不含全文） */
export function consolidationPlan({ month, now = new Date(), diaryDir, impressionsFile, speechFile, pinFile } = {}) {
  const entries = collectEntries({ month, now, diaryDir, impressionsFile, speechFile, pinFile })
  const groups = {}
  for (const category of CATEGORIES) {
    const list = entries.filter((entry) => entry.category === category)
    const eligible = list.filter((entry) => !entry.pinned && !entry.recent)
    const target = eligible.length < MIN_ELIGIBLE ? eligible.length : Math.ceil(eligible.length * KEEP_RATIO)
    groups[category] = {
      total: list.length,
      protected: list.length - eligible.length,
      eligible: eligible.length,
      target,
      items: list.map((entry) => ({
        id: entry.id,
        at: entry.at,
        pinned: entry.pinned,
        recent: entry.recent,
        preview: String(entry.text || '').replace(/\s+/g, ' ').slice(0, 100),
      })),
    }
  }
  return {
    month: month || previousMonth(now),
    now: now.toISOString(),
    ratio: KEEP_RATIO,
    recentDays: RECENT_DAYS,
    categories: groups,
    total: entries.length,
  }
}

function shuffle(list) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

/**
 * 执行整理。keep 是 agent 选的 id 列表；不足 63% 会随机补，超出会随机裁。
 * @returns {{ok:true, month:string, kept:object, forgotten:object, archive:string, summary:string}}
 */
export function consolidate({
  month,
  keep = [],
  summary = '',
  now = new Date(),
  diaryDir,
  impressionsFile,
  speechFile,
  pinFile,
  metaFile,
  summaryFile,
  archiveDir,
} = {}) {
  const targetMonth = month || previousMonth(now)
  const entries = collectEntries({ month: targetMonth, now, diaryDir, impressionsFile, speechFile, pinFile })
  if (!entries.length) return { ok: true, month: targetMonth, empty: true, kept: {}, forgotten: {}, archive: '', summary }

  const keepSet = new Set(keep.map(String))
  const protectedIds = new Set(entries.filter((entry) => entry.pinned || entry.recent).map((entry) => entry.id))
  const kept = {}
  const forgotten = {}

  for (const category of CATEGORIES) {
    const list = entries.filter((entry) => entry.category === category)
    const eligible = list.filter((entry) => !entry.pinned && !entry.recent)
    const target = eligible.length < MIN_ELIGIBLE ? eligible.length : Math.ceil(eligible.length * KEEP_RATIO)
    const requested = eligible.filter((entry) => keepSet.has(entry.id))
    let chosen = requested
    if (chosen.length > target) chosen = shuffle(chosen).slice(0, target)
    if (chosen.length < target) {
      const rest = shuffle(eligible.filter((entry) => !chosen.includes(entry)))
      chosen = [...chosen, ...rest.slice(0, target - chosen.length)]
    }
    const keepIds = new Set([...list.filter((entry) => entry.pinned || entry.recent).map((entry) => entry.id), ...chosen.map((entry) => entry.id)])
    kept[category] = list.filter((entry) => keepIds.has(entry.id)).map((entry) => entry.id)
    forgotten[category] = list.filter((entry) => !keepIds.has(entry.id)).map((entry) => entry.id)
  }

  const keepIds = new Set(Object.values(kept).flat())
  // 只动这个月的条目；其他月份/当前月的条目原样保留
  const monthIds = new Set(entries.map((entry) => entry.id))
  const archiveRoot = archiveDir || MEMORY_DIR
  const archive = path.join(archiveRoot, targetMonth)
  fs.mkdirSync(archive, { recursive: true })

  // 归档完整月（主人可查；她的 CLI 不提供读取入口）
  for (const scope of ['public', 'private']) {
    const file = diaryFile(scope, { dir: diaryDir })
    writeText(path.join(archive, `diary-${scope}.md`), readText(file))
  }
  writeJson(path.join(archive, 'impressions.json'), {
    version: 1,
    items: entries.filter((entry) => entry.category === 'impressions').map((entry) => entry.item),
  })
  writeText(
    path.join(archive, 'speech.jsonl'),
    entries
      .filter((entry) => entry.category === 'speech')
      .map((entry) => JSON.stringify(entry.item))
      .join('\n') + '\n',
  )
  writeText(path.join(archive, 'summary.md'), `${summary || '（这个月没有写总结）'}\n`)
  writeJson(path.join(archive, 'meta.json'), {
    month: targetMonth,
    archivedAt: now.toISOString(),
    ratio: KEEP_RATIO,
    entries: entries.length,
    kept: Object.fromEntries(Object.entries(kept).map(([key, value]) => [key, value.length])),
    forgotten: Object.fromEntries(Object.entries(forgotten).map(([key, value]) => [key, value.length])),
  })

  // 重写日记：保留 header + 留下的条目
  for (const scope of ['public', 'private']) {
    const file = diaryFile(scope, { dir: diaryDir })
    const text = readText(file)
    if (!text) continue
    const parsed = parseDiary(text)
    const category = `diary-${scope}`
    const keptRaw = parsed.entries
      .map((entry, index) => ({
        raw: entry.raw,
        id: diaryId(scope, entry, index),
      }))
      .filter((entry) => !monthIds.has(entry.id) || keepIds.has(entry.id))
      .map((entry) => entry.raw)
    writeText(file, `${parsed.header}\n\n${keptRaw.join('\n\n')}${keptRaw.length ? '\n' : ''}`)
  }

  // 重写印象
  const impressionIds = new Set(
    Object.keys(kept).includes('impressions')
      ? kept.impressions.map((id) => id.replace(/^i:/, ''))
      : [],
  )
  if (fs.existsSync(impressionsFile || path.join(STATE_DIR, 'impressions.json'))) {
    const items = loadImpressions({ file: impressionsFile }).filter(
      (item) => !monthIds.has(`i:${item.id}`) || impressionIds.has(item.id),
    )
    saveImpressions(items, { file: impressionsFile })
  }

  // 重写发言记录
  const speechIds = new Set(
    Object.keys(kept).includes('speech') ? kept.speech.map((id) => id.replace(/^s:/, '')) : [],
  )
  const speechFileResolved = speechFile || path.join(STATE_DIR, 'speech.jsonl')
  if (fs.existsSync(speechFileResolved)) {
    const keptLines = readSpeech({ file: speechFileResolved })
      .filter((item) => !monthIds.has(`s:${item.id}`) || speechIds.has(item.id))
      .map((item) => JSON.stringify(item))
    writeText(speechFileResolved, keptLines.length ? `${keptLines.join('\n')}\n` : '')
  }

  if (summary) {
    writeText(summaryFile || SUMMARY_FILE, `${summary}\n`)
  }

  const meta = loadMeta({ file: metaFile })
  meta.lastConsolidatedAt = now.toISOString()
  meta.lastMonth = targetMonth
  meta.stats = {
    entries: entries.length,
    kept: Object.fromEntries(Object.entries(kept).map(([key, value]) => [key, value.length])),
    forgotten: Object.fromEntries(Object.entries(forgotten).map(([key, value]) => [key, value.length])),
  }
  saveMeta(meta, { file: metaFile })

  return {
    ok: true,
    month: targetMonth,
    empty: false,
    kept: meta.stats.kept,
    forgotten: meta.stats.forgotten,
    archive,
    summary,
  }
}

export function memoryStats({ diaryDir, impressionsFile, speechFile } = {}) {
  const entries = collectEntries({ month: null, diaryDir, impressionsFile, speechFile, includeRecent: true })
  const counts = {}
  for (const category of CATEGORIES) counts[category] = entries.filter((entry) => entry.category === category).length
  const meta = loadMeta()
  return {
    counts,
    pins: loadPins().length,
    lastConsolidatedAt: meta.lastConsolidatedAt,
    lastMonth: meta.lastMonth,
    archiveDir: MEMORY_DIR,
    summaryFile: SUMMARY_FILE,
    summary: readText(SUMMARY_FILE).trim().slice(0, 300),
  }
}
