// src/comments.mjs — 她发过的每一条评论，单独记一个文件
//
// 用户要求（2026-10-26）：**每发一条评论都记到一个文件里，格式「视频链接 + 评论内容」**。
// 所以这里不存 JSON，直接存人能一眼看懂的 Markdown：
//
//   ## 2026-10-26 11:45
//   https://www.bilibili.com/video/BV1xx411c7mD
//   这条视频讲得实在，看完心里有个钩子。
//
// 写入时机：`life action comment` **发送成功之后**（dry-run / 失败不记），
// 和 speech.jsonl 是两条独立的账：speech 用来防复读，comments.md 用来「回头看她到底在谁那儿说过什么」。
import fs from 'node:fs'
import path from 'node:path'

import { STATE_DIR } from './state.mjs'
import { formatStamp } from './diary.mjs'

/** 评论台账：默认 <BILI_LITE_HOME>/state/comments.md */
export const COMMENTS_FILE = path.join(STATE_DIR, 'comments.md')

/** 单条评论正文上限（B 站单条上限 1000 字，这里按 1000 存） */
const MAX_TEXT_CHARS = 1000

const HEADER = [
  '# 她发过的评论 · 小蓝鲸',
  '',
  '> 每发一条评论自动记一条，格式：时间 → 视频链接 → 评论内容。',
  '> 写入：`life action comment --bvid BV… --text "…"` 发送成功后自动追加（时间按北京时间）。',
  '> 只记真发出去的；dry-run、被拦下、发送失败都不记。',
  '',
].join('\n')

export function commentsFile(opts = {}) {
  return opts.file || COMMENTS_FILE
}

/** 建文件（幂等；只补缺失，不覆盖已有内容） */
export function ensureComments(opts = {}) {
  const file = commentsFile(opts)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER, 'utf8')
  return file
}

/** 视频链接：只接受 BV 号，返回标准 URL */
export function bvidUrl(bvid) {
  const id = String(bvid || '').trim()
  if (!/^BV[0-9A-Za-z]{10}$/.test(id)) throw new Error(`bvid 不合法：${bvid}`)
  return `https://www.bilibili.com/video/${id}`
}

/**
 * 追加一条评论记录。
 * @param {{bvid:string, text:string, at?:Date, mood?:string, rpid?:string, file?:string}} input
 * @returns {{ok:true, file:string, stamp:string, url:string, bvid:string, text:string, entries:number, duplicate?:boolean}}
 */
export function appendComment({ bvid, text, at = new Date(), mood = '', rpid = '', file } = {}) {
  const url = bvidUrl(bvid)
  const id = String(bvid).trim()
  const body = String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS)
  if (!body) throw new Error('评论内容不能为空')

  const target = ensureComments({ file })
  const entries = readComments({ file: target })
  const last = entries[entries.length - 1]
  // 同一条视频、同一段话连发两次（重试）不重复记
  if (last && last.bvid === id && last.text === body) {
    return { ok: true, duplicate: true, file: target, stamp: last.stamp, url, bvid: id, text: body, entries: entries.length }
  }

  const stamp = formatStamp(at)
  const block = `## ${stamp}\n${url}\n${body}\n`
  fs.appendFileSync(target, `\n${block}`, 'utf8')
  return {
    ok: true,
    file: target,
    stamp,
    url,
    bvid: id,
    text: body,
    entries: readComments({ file: target }).length,
    ...(mood ? { mood: String(mood) } : {}),
    ...(rpid ? { rpid: String(rpid) } : {}),
  }
}

/** 把文件拆成条目：{ stamp, url, bvid, text, raw } */
export function parseComments(text) {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const lines = source.split('\n')
  const starts = []
  for (let i = 0; i < lines.length; i++) {
    if (/^## \d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(lines[i])) starts.push(i)
  }
  if (!starts.length) return { header: source.trim(), entries: [] }
  const header = lines.slice(0, starts[0]).join('\n').trim()
  const entries = []
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : lines.length
    const raw = lines.slice(from, to).join('\n').trim()
    const stamp = lines[from].slice(3).trim()
    const rest = lines.slice(from + 1, to).map((line) => line.trimEnd())
    // 第一行非空是视频链接，剩下的是评论正文
    const linkIndex = rest.findIndex((line) => /^https?:\/\//.test(line.trim()))
    const url = linkIndex >= 0 ? rest[linkIndex].trim() : ''
    const bvid = (/(BV[0-9A-Za-z]{10})/.exec(url) || [])[1] || ''
    const bodyLines = linkIndex >= 0 ? rest.slice(linkIndex + 1) : rest
    const body = bodyLines.join('\n').trim()
    entries.push({ stamp, url, bvid, text: body, raw })
  }
  return { header, entries }
}

export function readComments(opts = {}) {
  try {
    return parseComments(fs.readFileSync(commentsFile(opts), 'utf8')).entries
  } catch {
    return []
  }
}

/** 最近 N 条（默认全部倒序交给 CLI 用） */
export function recentComments({ limit = 10, file } = {}) {
  return readComments({ file }).slice(-Math.max(1, Number(limit) || 10))
}

export function commentsStats(opts = {}) {
  const file = commentsFile(opts)
  const entries = readComments({ file })
  let updatedAt = null
  try {
    updatedAt = fs.statSync(file).mtime.toISOString()
  } catch {
    /* 还没写过 */
  }
  const bvids = [...new Set(entries.map((entry) => entry.bvid).filter(Boolean))]
  return {
    file,
    entries: entries.length,
    videos: bvids.length,
    updatedAt,
    last: entries[entries.length - 1]
      ? `${entries[entries.length - 1].stamp} · ${entries[entries.length - 1].bvid}`
      : null,
  }
}
