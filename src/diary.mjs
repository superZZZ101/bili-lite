// src/diary.mjs — 小蓝鲸的两本日记（公开 / 私密）
//
// 设计（2026-10-23，对应主人给的「会话重置」卡片）：
//   - 公开日记 state/../diary/public.md：主人随时可以看，可以拿来聊天、引用；
//   - 私密日记 state/../diary/private.md：只给她自己看，不主动展示、不复述、不发私信、不写报告；
//   - 每次会话重置时，两本日记都会被塞进「重置包」（见 session.mjs），所以她不会失忆；
//   - 文件是普通 Markdown，按 `## 时间 · 标题` 分条，写入统一走 `diary add`，不手改也行。
//
// 运行时目录：默认 <BILI_LITE_HOME>/diary/，与 state/、reports/ 平级；
// 测试可以传 { dir } 指到临时目录，不碰真实数据。
import fs from 'node:fs'
import path from 'node:path'

import { STATE_DIR } from './state.mjs'
import { beijingParts } from './calendar.mjs'

/** 日记根目录：默认与 state/ 平级（<HOME>/diary），可用 BILI_LITE_DIARY_DIR 覆盖 */
export const DEFAULT_DIARY_DIR = path.join(path.dirname(STATE_DIR), 'diary')

/** 单个 scope 的元信息：文件名、标题、用途说明 */
export const SCOPE_META = {
  public: {
    file: 'public.md',
    title: '# 公开日记 · 小蓝鲸',
    label: '公开日记 · 主人可以看',
    note: [
      '> 这本日记主人随时可以看，也可以拿来跟主人聊、引用。',
      '> 写入：node src/cli.mjs diary add --text "…"（时间按北京时间）。',
    ].join('\n'),
  },
  private: {
    file: 'private.md',
    title: '# 私密日记 · 小蓝鲸',
    label: '私密日记 · 只有你自己看',
    note: [
      '> 这本只有小蓝鲸自己看：不主动展示、不复述、不发私信、不写进报告。',
      '> 写入：node src/cli.mjs diary add --private --text "…"（时间按北京时间）。',
    ].join('\n'),
  },
}

/** 单条日记正文上限（字符） */
const MAX_ENTRY_CHARS = 1500
/** 文件超过这个字符数且条数够多时，把最旧的条目归档到 diary/archive/ */
const ARCHIVE_THRESHOLD_CHARS = 24_000
/** 归档时保留的最近条数 */
const KEEP_ENTRIES = 100

export function scopeMeta(scope) {
  const meta = SCOPE_META[String(scope || '')]
  if (!meta) throw new Error(`未知的日记类型：${scope}（只能是 public / private）`)
  return meta
}

/** 解析日记目录（测试可覆盖） */
export function diaryDir(opts = {}) {
  const dir = opts.dir || process.env.BILI_LITE_DIARY_DIR || DEFAULT_DIARY_DIR
  return path.resolve(dir)
}

export function diaryFile(scope, opts = {}) {
  return path.join(diaryDir(opts), scopeMeta(scope).file)
}

function headerFor(scope) {
  const meta = scopeMeta(scope)
  return `${meta.title}\n\n${meta.note}\n\n`
}

/** 创建目录与两本日记（幂等；只补缺失的文件，不覆盖已有内容） */
export function ensureDiary(scope, opts = {}) {
  const dir = diaryDir(opts)
  fs.mkdirSync(dir, { recursive: true })
  const file = diaryFile(scope, opts)
  if (!fs.existsSync(file)) fs.writeFileSync(file, headerFor(scope), 'utf8')
  return file
}

/** 北京时间 `YYYY-MM-DD HH:mm` */
export function formatStamp(at = new Date()) {
  const parts = beijingParts(at)
  const pad = (n) => String(n).padStart(2, '0')
  return `${parts.dateStr} ${pad(parts.hour)}:${pad(parts.minute)}`
}

/** 把文件拆成 { header, entries }；entry 含 stamp/title/body/raw */
export function parseDiary(text) {
  const source = String(text || '').replace(/\r\n/g, '\n')
  const lines = source.split('\n')
  const starts = []
  // 只把「## YYYY-MM-DD HH:mm · 标题」当条目头，正文里出现 ## 不会把日记切坏
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
    const first = lines[from].slice(3).trim()
    const sep = first.indexOf('·')
    const stamp = sep >= 0 ? first.slice(0, sep).trim() : first
    const title = sep >= 0 ? first.slice(sep + 1).trim() : ''
    const body = lines
      .slice(from + 1, to)
      .join('\n')
      .trim()
    entries.push({ stamp, title, body, raw })
  }
  return { header, entries }
}

/** 读取一本日记的全部条目 */
export function readEntries(scope, opts = {}) {
  const file = ensureDiary(scope, opts)
  const text = fs.readFileSync(file, 'utf8')
  return parseDiary(text).entries
}

/** 读取原始文本（cli diary read 用） */
export function readDiaryText(scope, opts = {}) {
  return fs.readFileSync(ensureDiary(scope, opts), 'utf8')
}

function normalizeBody(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_ENTRY_CHARS)
}

function normalizeTitle(title, body) {
  const source = String(title || '').trim() || String(body || '').split('\n')[0] || '没写标题'
  const clean = source
    .replace(/^#+\s*/, '')
    .replace(/\s+/g, ' ')
    .replace(/·/g, '／')
    .trim()
  return (clean.slice(0, 24) || '没写标题').replace(/[\[\]]/g, '')
}

function archiveIfNeeded(scope, opts = {}) {
  const file = diaryFile(scope, opts)
  const text = fs.readFileSync(file, 'utf8')
  if (text.length <= ARCHIVE_THRESHOLD_CHARS) return null
  const { header, entries } = parseDiary(text)
  if (entries.length <= KEEP_ENTRIES) return null
  const old = entries.slice(0, entries.length - KEEP_ENTRIES)
  const keep = entries.slice(-KEEP_ENTRIES)
  const archiveDir = path.join(diaryDir(opts), 'archive')
  fs.mkdirSync(archiveDir, { recursive: true })
  const stamp = formatStamp().slice(0, 7)
  const archiveFile = path.join(archiveDir, `${scope}-${stamp}.md`)
  fs.appendFileSync(
    archiveFile,
    `${old.map((e) => e.raw).join('\n\n')}\n\n`,
    'utf8',
  )
  fs.writeFileSync(file, `${header}\n\n${keep.map((e) => e.raw).join('\n\n')}\n`, 'utf8')
  return archiveFile
}

/**
 * 追加一条日记。
 * @param {'public'|'private'} scope
 * @param {{text:string, title?:string, at?:Date, dir?:string, bvid?:string}} entry
 * @returns {{ok:boolean, scope:string, file:string, title:string, stamp:string, entries:number, duplicate?:boolean, link?:string}}
 */
export function appendEntry(scope, { text, title = '', at = new Date(), dir, bvid = '' } = {}) {
  const meta = scopeMeta(scope)
  const id = String(bvid || '').trim()
  let raw = String(text || '')
  let link = ''
  if (id) {
    if (!/^BV[0-9A-Za-z]+$/.test(id)) throw new Error(`bvid 不合法：${bvid}`)
    link = `https://www.bilibili.com/video/${id}`
    if (!raw.includes(id)) raw = `${raw}\n${link}`
  }
  const body = normalizeBody(raw)
  if (!body) throw new Error('日记内容不能为空')
  const file = ensureDiary(scope, { dir })
  const entries = readEntries(scope, { dir })
  const last = entries[entries.length - 1]
  if (last && last.body.trim() === body) {
    return {
      ok: true,
      duplicate: true,
      scope,
      file,
      title: last.title,
      stamp: last.stamp,
      entries: entries.length,
    }
  }
  const stamp = formatStamp(at)
  const safeTitle = normalizeTitle(title, body)
  const block = `## ${stamp} · ${safeTitle}\n\n${body}\n`
  fs.appendFileSync(file, `\n${block}`, 'utf8')
  archiveIfNeeded(scope, { dir })
  return {
    ok: true,
    scope,
    label: meta.label,
    file,
    title: safeTitle,
    stamp,
    entries: readEntries(scope, { dir }).length,
    ...(link ? { link } : {}),
  }
}

/**
 * 渲染成提示词片段：从最新往前取，累计不超过 maxChars。
 * @param {'public'|'private'} scope
 * @param {{maxChars?:number, dir?:string}} opts
 */
export function renderForPrompt(scope, { maxChars = 2600, dir } = {}) {
  const meta = scopeMeta(scope)
  const entries = readEntries(scope, { dir })
  const label = `【${meta.label}】`
  if (!entries.length) return `${label}\n（还没有写）`
  const picked = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const block = entries[i].raw
    if (picked.length && used + block.length > maxChars) break
    picked.unshift(block)
    used += block.length
    if (picked.length >= 12) break
  }
  const omitted = entries.length - picked.length
  return [
    label,
    picked.join('\n\n'),
    omitted > 0 ? `（更早的 ${omitted} 条在文件里，这里只带最近几条）` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** 一次渲染两本日记（重置包用） */
export function buildDiaryPack({ maxChars = 2600, dir } = {}) {
  return [renderForPrompt('public', { maxChars, dir }), '', renderForPrompt('private', { maxChars, dir })].join('\n')
}

/** 概览：条数 / 字符数 / 最后更新时间 / 路径（私密日记不返回正文） */
export function diaryStats({ dir } = {}) {
  const out = {}
  for (const scope of Object.keys(SCOPE_META)) {
    const file = diaryFile(scope, { dir })
    let text = ''
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      /* 没写过 */
    }
    const entries = parseDiary(text).entries
    let updatedAt = null
    try {
      updatedAt = fs.statSync(file).mtime.toISOString()
    } catch {
      /* ignore */
    }
    const lastEntry = entries[entries.length - 1]
    out[scope] = {
      label: SCOPE_META[scope].label,
      file,
      entries: entries.length,
      chars: text.length,
      updatedAt,
      // 私密日记连标题都不在概览里出现（标题可能就是从正文第一句取的）
      last: lastEntry ? (scope === 'private' ? lastEntry.stamp : `${lastEntry.stamp} · ${lastEntry.title}`) : null,
    }
  }
  return out
}
