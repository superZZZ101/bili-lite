// src/impressions.mjs — 「印象」：她对看过的东西的结构化记忆
//
// 日记是散文（她怎么想）；印象是索引（她记住了什么）：
//   作者 / 题目 / 内容里的一个点 / 评论区一句 / 她自己的感觉 / 时间。
// 链接可选——人可以没存链接，只记得大概。
// 回忆时按心情和话题挑 2~4 个，讲成故事，不照读。
import fs from 'node:fs'
import path from 'node:path'

import { STATE_DIR } from './state.mjs'

export const IMPRESSIONS_FILE = path.join(STATE_DIR, 'impressions.json')
const MAX_ITEMS = 300
const FUZZY_AFTER_DAYS = 30

function fileOf(opts = {}) {
  return opts.file || IMPRESSIONS_FILE
}

export function loadImpressions(opts = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(opts), 'utf8'))
    const items = Array.isArray(raw) ? raw : raw && Array.isArray(raw.items) ? raw.items : []
    return items.map(normalizeItem)
  } catch {
    return []
  }
}

export function saveImpressions(items, opts = {}) {
  const file = fileOf(opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const clean = (items || []).map(normalizeItem).slice(-MAX_ITEMS)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items: clean }, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return clean
}

function normalizeItem(raw) {
  const at = raw && raw.at ? String(raw.at) : new Date().toISOString()
  return {
    id: String((raw && raw.id) || `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    at,
    title: String((raw && raw.title) || '').slice(0, 120),
    author: String((raw && raw.author) || '').slice(0, 60),
    bvid: String((raw && raw.bvid) || ''),
    content: String((raw && raw.content) || '').slice(0, 500),
    comment: String((raw && raw.comment) || '').slice(0, 300),
    why: String((raw && raw.why) || '').slice(0, 500),
    mood: String((raw && raw.mood) || ''),
    tags: Array.isArray(raw && raw.tags) ? raw.tags.slice(0, 8).map(String) : [],
    source: String((raw && raw.source) || 'life'),
    pinned: Boolean(raw && raw.pinned),
  }
}

function isFuzzy(item, now = Date.now()) {
  const at = new Date(item.at).getTime()
  if (!Number.isFinite(at)) return true
  return now - at > FUZZY_AFTER_DAYS * 86400_000
}

/**
 * 记一条印象。
 * @param {{title?:string, author?:string, bvid?:string, content?:string, comment?:string, why?:string, mood?:string, tags?:string[], source?:string}} input
 */
export function addImpression(input = {}, opts = {}) {
  const items = loadImpressions(opts)
  const item = normalizeItem({
    ...input,
    id: input.id || `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: input.at || new Date().toISOString(),
  })
  if (!item.title && !item.content && !item.why) throw new Error('印象至少要有标题、内容或感觉')
  // 同一条视频、同样的感觉，不重复记
  const duplicate = items.find(
    (old) => (item.bvid && old.bvid === item.bvid && old.why.slice(0, 40) === item.why.slice(0, 40)) ||
      (!item.bvid && old.title === item.title && old.why.slice(0, 40) === item.why.slice(0, 40)),
  )
  if (duplicate) return { ok: true, duplicate: true, item: duplicate, count: items.length }
  items.push(item)
  const saved = saveImpressions(items, opts)
  return { ok: true, duplicate: false, item, count: saved.length }
}

/** 按话题/心情/时间挑几条，交给模型讲成回忆 */
export function recallImpressions({ limit = 4, topic = '', mood = '', file } = {}) {
  const items = loadImpressions({ file })
  const now = Date.now()
  const keyword = String(topic || '').toLowerCase()
  const scored = items.map((item) => {
    let score = 0
    if (item.pinned) score += 8
    if (keyword) {
      const hay = `${item.title} ${item.author} ${item.content} ${item.comment} ${item.why} ${item.tags.join(' ')}`.toLowerCase()
      if (hay.includes(keyword)) score += 10
      for (const word of keyword.split(/\s+/).filter(Boolean)) if (hay.includes(word)) score += 3
    }
    if (mood && item.mood === mood) score += 4
    const ageDays = Math.max(0, (now - new Date(item.at).getTime()) / 86400_000)
    score += Math.max(0, 6 - ageDays / 7)
    score += Math.random() * 2
    return { item, score, fuzzy: isFuzzy(item, now) }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, Math.max(1, Math.min(8, Number(limit) || 4))).map((entry) => ({
    ...entry.item,
    fuzzy: entry.fuzzy,
  }))
}

/** 给提示词的回忆材料：不是台词，是“可以拿来回忆的东西” */
export function renderRecall(items) {
  if (!items || !items.length) return '（最近没有记住什么。）'
  return items
    .map((item, index) => {
      const parts = [
        `${index + 1}. ${item.title || '（想不起标题）'}${item.author ? ` · ${item.author}` : ''}`,
        item.content ? `   内容：${item.content}` : '',
        item.comment ? `   评论：${item.comment}` : '',
        item.why ? `   当时的感觉：${item.why}` : '',
        item.bvid && !item.fuzzy ? `   链接：https://www.bilibili.com/video/${item.bvid}` : '   链接：没记住',
        item.fuzzy ? '   （有点模糊了，细节别硬说）' : '',
      ].filter(Boolean)
      return parts.join('\n')
    })
    .join('\n\n')
}

/** 概览（不把正文塞给主人看） */
export function impressionStats(opts = {}) {
  const items = loadImpressions(opts)
  return {
    count: items.length,
    pinned: items.filter((item) => item.pinned).length,
    latest: items.length ? items[items.length - 1].at : null,
    file: fileOf(opts),
  }
}

/** 固定/取消固定（固定不参与每月遗忘） */
export function pinImpression(id, pinned = true, opts = {}) {
  const items = loadImpressions(opts)
  const item = items.find((entry) => entry.id === id)
  if (!item) return { ok: false, error: `找不到印象 ${id}` }
  item.pinned = Boolean(pinned)
  saveImpressions(items, opts)
  return { ok: true, item }
}
