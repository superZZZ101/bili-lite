// src/enrich.mjs — 字幕 / 弹幕热区 / 封面下载（零依赖，网络调用均可注入，便于离线单测）
// 设计要点：
// 1. 所有网络访问都收口到 opts.fetchJson / opts.fetchText / opts.fetchBytes，默认走 http.mjs + Node fetch。
// 2. 字幕接口需要 WBI 签名（wbi.mjs 的 getWbiKeys + signWbi）。
//    实测匿名请求通常 code=0 但 subtitle.subtitles=[] 且 login_mid=0：字幕要登录后才拿得到，
//    因此返回 { available:false, loginRequired:true, hint } 做结构化降级，不抛错、不伪造字幕。
// 3. 弹幕 XML 可能以 deflate/gzip 原样返回，fetch 未解压时用 node:zlib 兜底。
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { biliFetch, DEFAULT_HEADERS } from './http.mjs'
import { getWbiKeys, signWbi } from './wbi.mjs'

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const COVER_DIR = path.join(ROOT_DIR, 'state', 'covers')

const SUBTITLE_API = 'https://api.bilibili.com/x/player/wbi/v2'
const DANMAKU_API = 'https://comment.bilibili.com'

let stateModulePromise = null

function errText(error) {
  return error && error.message ? error.message : String(error)
}

/** //host/path -> https://host/path；http:// 统一升级为 https:// */
function normalizeUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (raw.startsWith('//')) return `https:${raw}`
  if (raw.startsWith('http://')) return `https://${raw.slice('http://'.length)}`
  return raw
}

function buildHeaders(jar, referer, extra = {}) {
  const headers = { ...DEFAULT_HEADERS, ...extra }
  if (referer) headers.Referer = referer
  if (jar && typeof jar.header === 'function' && jar.header()) headers.Cookie = jar.header()
  return headers
}

function defaultFetchJson(url, { jar, referer } = {}) {
  return biliFetch(url, { jar, referer })
}

function looksLikeXml(text) {
  return /<\s*(?:i|d)\b/i.test(text)
}

/** 优先按 UTF-8 解码；乱码时尝试 gzip / zlib / raw deflate */
function decodeXmlBytes(buf) {
  if (!buf || !buf.length) return ''
  const utf8 = new TextDecoder('utf-8').decode(buf).replace(/^\uFEFF/, '')
  if (looksLikeXml(utf8)) return utf8
  const attempts = [
    () => zlib.gunzipSync(buf).toString('utf8'),
    () => zlib.inflateSync(buf).toString('utf8'),
    () => zlib.inflateRawSync(buf).toString('utf8'),
  ]
  for (const attempt of attempts) {
    try {
      const text = attempt().replace(/^\uFEFF/, '')
      if (looksLikeXml(text)) return text
    } catch {
      // 换下一种解压方式
    }
  }
  return utf8
}

async function defaultFetchText(url, { jar, referer, headers } = {}) {
  const response = await fetch(url, {
    headers: buildHeaders(jar, referer, { 'Accept-Encoding': 'identity', ...(headers || {}) }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return decodeXmlBytes(Buffer.from(await response.arrayBuffer()))
}

async function defaultFetchBytes(url, { jar, referer, headers } = {}) {
  const response = await fetch(url, {
    headers: buildHeaders(jar, referer, {
      Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      ...(headers || {}),
    }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

// ---------------- WBI ----------------

async function resolveMixin(jar, opts) {
  if (opts.mixin) return String(opts.mixin)
  const getKeys = typeof opts.getWbiKeys === 'function' ? opts.getWbiKeys : getWbiKeys
  const keys = await getKeys(jar)
  const mixin = typeof keys === 'string' ? keys : keys && keys.mixin
  if (!mixin) throw new Error('getWbiKeys 未返回 mixin key')
  return mixin
}

// ---------------- 字幕 ----------------

function isLoginRequired(payload) {
  const flags = [
    payload && payload.login_required,
    payload && payload.loginRequired,
    payload && payload.subtitle && payload.subtitle.login_required,
    payload && payload.subtitle && payload.subtitle.loginRequired,
  ]
  if (flags.some((v) => v === 1 || v === true || v === '1')) return true
  const mid = payload ? payload.login_mid ?? payload.loginMid : undefined
  return mid === 0 || mid === '0'
}

function pickSubtitle(list) {
  const usable = (Array.isArray(list) ? list : []).filter((s) => s && s.url)
  return (
    usable.find((s) => /^(zh|ai-zh)/i.test(String(s.lan || ''))) ||
    usable.find((s) => /中文|chinese/i.test(String(s.lanDoc || ''))) ||
    usable[0] ||
    null
  )
}

/**
 * 获取视频字幕列表（WBI 签名）。
 * 注意：B 站要求登录后才返回字幕列表。匿名请求通常 available=false、loginRequired=true，
 * 这不是错误，调用方应把 loginRequired 当作「需要登录」的提示而不是异常。
 * 离线测试可注入 fetchJson（字幕接口）与 mixin 或 getWbiKeys（跳过真实 nav 请求）。
 * @param {object} [extra] { fetchJson, mixin, getWbiKeys }
 * @returns {Promise<{available:boolean, loginRequired:boolean, subtitles:Array<{lan:string,lanDoc:string,url:string,aiType:number}>, hint:string, error?:string, code?:number}>}
 */
export async function getSubtitles(jar, params = {}, extra = {}) {
  const { bvid, cid, ...rest } = params || {}
  const opts = { ...rest, ...extra }

  const unavailable = (loginRequired, hint, error) => {
    const result = { available: false, loginRequired: Boolean(loginRequired), subtitles: [], hint }
    if (error) result.error = error
    return result
  }

  if (!bvid || !cid) return unavailable(false, '缺少 bvid 或 cid，无法请求字幕')

  let mixin
  try {
    mixin = await resolveMixin(jar, opts)
  } catch (error) {
    return unavailable(false, `WBI 签名失败：${errText(error)}`, errText(error))
  }

  const query = signWbi({ bvid: String(bvid), cid: String(cid) }, mixin)
  const fetchJson = opts.fetchJson || defaultFetchJson
  const referer = `https://www.bilibili.com/video/${bvid}`
  let response
  try {
    response = await fetchJson(`${SUBTITLE_API}?${query}`, { jar, referer })
  } catch (error) {
    return unavailable(false, `字幕接口请求失败：${errText(error)}`, errText(error))
  }

  if (!response || response.code !== 0) {
    const code = response && response.code
    const message = (response && (response.message || response.msg)) || '未知错误'
    return { ...unavailable(code === -101, `字幕接口失败：${message}（code=${code}）`), code }
  }

  const payload = response.data || {}
  const subtitle = payload.subtitle || {}
  const rawList = Array.isArray(subtitle.subtitles) ? subtitle.subtitles : []
  const mapped = rawList
    .filter((s) => s && (s.subtitle_url || s.subtitle_url_v2))
    .map((s) => ({
      lan: s.lan || '',
      lanDoc: s.lan_doc || s.lanDoc || '',
      url: normalizeUrl(s.subtitle_url || s.subtitle_url_v2),
      aiType: Number(s.ai_type ?? s.aiType ?? 0) || 0,
    }))
    .filter((s) => s.url)

  if (mapped.length) return { available: true, loginRequired: false, subtitles: mapped, hint: '' }

  const loginRequired = isLoginRequired(payload)
  return unavailable(
    loginRequired,
    loginRequired
      ? '匿名请求拿不到字幕列表（login_mid=0 / 需要登录），登录后重试'
      : '该视频没有可用字幕（UP 未上传或字幕不可见）',
  )
}

/**
 * 拉取并解析字幕 JSON。
 * @param {string} url subtitle_url（可能以 // 开头）
 * @returns {Promise<Array<{from:number,to:number,text:string}>>}
 */
export async function fetchSubtitleText(jar, url, options = {}) {
  const target = normalizeUrl(url)
  if (!target) throw new Error('字幕地址为空')
  const fetchJson = options.fetchJson || defaultFetchJson
  const data = await fetchJson(target, {
    jar,
    referer: options.referer || 'https://www.bilibili.com/',
  })
  const body = Array.isArray(data)
    ? data
    : Array.isArray(data && data.body)
      ? data.body
      : Array.isArray(data && data.data && data.data.body)
        ? data.data.body
        : null
  if (!body) {
    if (data && data._raw) {
      throw new Error(`字幕内容不是 JSON：${String(data.message || '').slice(0, 80)}`)
    }
    return []
  }
  return body
    .map((line) => ({
      from: Number(line && line.from) || 0,
      to: Number(line && line.to) || 0,
      text: String((line && (line.content ?? line.text)) ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/\s*\n\s*/g, ' ')
        .trim(),
    }))
    .filter((line) => line.text)
}

function needsSpace(prev, next) {
  // 中英混排时只给英文之间补空格，避免中文被拆开
  return /[A-Za-z0-9.,!?;:'")\]”’]/.test(prev) && /[A-Za-z0-9'"“‘([]/.test(next)
}

/**
 * 按句把字幕拼成一段纯文本（默认最多 3000 字）。
 * @param {Array<{text:string}|string>} lines
 * @param {{maxChars?:number}|number} options
 */
export function toPlainText(lines, options = {}) {
  const maxChars =
    typeof options === 'number' ? options : Number(options && options.maxChars) || 3000
  const list = Array.isArray(lines) ? lines : []
  let out = ''
  for (const line of list) {
    const raw = typeof line === 'string' ? line : line && (line.text ?? line.content)
    const text = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!text) continue
    if (!out) out = text
    else {
      const prev = out[out.length - 1]
      const next = text[0]
      if (needsSpace(prev, next)) out += ' '
      out += text
    }
    if (out.length >= maxChars) break
  }
  if (out.length > maxChars) {
    out = `${out.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
  }
  return out
}

// ---------------- 弹幕 ----------------

const ENTITY_MAP = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    const lower = body.toLowerCase()
    return Object.prototype.hasOwnProperty.call(ENTITY_MAP, lower) ? ENTITY_MAP[lower] : whole
  })
}

function cleanDanmakuText(raw) {
  const text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .trim()
  if (!text) return ''
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(text)
  if (cdata) return cdata[1].replace(/\s*\n\s*/g, ' ').trim()
  return decodeEntities(text).replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * 解析 B 站弹幕 XML：<d p="time,mode,size,color,ts,pool,uid,rowid">文本</d>
 * @returns {Array<{t:number,text:string}>} 按时间升序
 */
export function parseDanmakuXml(xml) {
  const source = String(xml || '')
  const items = []
  const re = /<d\b([^>]*)>([\s\S]*?)<\/d>/gi
  let match
  while ((match = re.exec(source))) {
    const attrs = match[1] || ''
    const pMatch = /\bp\s*=\s*"([^"]*)"/i.exec(attrs) || /\bp\s*=\s*'([^']*)'/i.exec(attrs)
    if (!pMatch) continue
    const fields = pMatch[1].split(',')
    const t = Number.parseFloat(fields[0])
    const text = cleanDanmakuText(match[2])
    if (!Number.isFinite(t) || t < 0 || !text) continue
    items.push({ t: Math.round(t * 1000) / 1000, text })
  }
  items.sort((a, b) => a.t - b.t)
  return items
}

/**
 * 拉取并解析弹幕。
 * @returns {Promise<{count:number, items:Array<{t:number,text:string}>, error?:string}>}
 */
export async function getDanmaku(jar, params = {}, extra = {}) {
  const { cid, ...rest } = params || {}
  const opts = { ...rest, ...extra }
  const fetchText = opts.fetchText || defaultFetchText
  if (!cid) return { count: 0, items: [], error: '缺少 cid' }
  const url = `${DANMAKU_API}/${encodeURIComponent(String(cid))}.xml`
  try {
    const xml = await fetchText(url, { jar, referer: 'https://www.bilibili.com/' })
    const items = parseDanmakuXml(xml)
    return { count: items.length, items }
  } catch (error) {
    return { count: 0, items: [], error: errText(error) }
  }
}

function danmakuItems(danmaku) {
  const list = Array.isArray(danmaku) ? danmaku : danmaku && Array.isArray(danmaku.items) ? danmaku.items : []
  return list
    .map((item) => ({
      t: Number(item && (item.t ?? item.time)),
      text: String((item && (item.text ?? item.content)) || '').trim(),
    }))
    .filter((item) => Number.isFinite(item.t) && item.t >= 0 && item.text)
}

function round3(value) {
  return Math.round(value * 1000) / 1000
}

/**
 * 把弹幕按时间分桶，找热区。
 * @returns {{buckets:Array<{from:number,to:number,count:number,top:string[]}>, hotspots:Array<{from:number,to:number,count:number}>}}
 */
export function danmakuHeat(danmaku, { duration = 0, buckets = 12 } = {}) {
  const items = danmakuItems(danmaku)
  const bucketCount = Math.max(1, Math.min(120, Math.floor(Number(buckets) || 12)))
  let total = Number(duration) || 0
  if (!(total > 0)) {
    const maxT = items.reduce((max, item) => Math.max(max, item.t), 0)
    total = maxT > 0 ? maxT + 0.001 : 1
  }
  const width = total / bucketCount
  const rawBuckets = Array.from({ length: bucketCount }, (_, index) => ({
    from: index * width,
    to: Math.min(total, (index + 1) * width),
    count: 0,
    texts: new Map(),
  }))

  for (const item of items) {
    const index = Math.min(bucketCount - 1, Math.floor(item.t / width))
    if (index < 0) continue
    const bucket = rawBuckets[index]
    bucket.count += 1
    bucket.texts.set(item.text, (bucket.texts.get(item.text) || 0) + 1)
  }

  const resultBuckets = rawBuckets.map((bucket) => ({
    from: round3(bucket.from),
    to: round3(bucket.to),
    count: bucket.count,
    top: [...bucket.texts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([text]) => text),
  }))

  const hotspots = resultBuckets
    .filter((bucket) => bucket.count > 0)
    .sort((a, b) => b.count - a.count || a.from - b.from)
    .slice(0, 3)
    .map(({ from, to, count }) => ({ from, to, count }))

  return { buckets: resultBuckets, hotspots }
}

function formatClock(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(value / 3600)
  const m = Math.floor((value % 3600) / 60)
  const s = value % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 生成一句中文弹幕热区摘要 */
export function summarizeHeat(heat) {
  const buckets = (heat && Array.isArray(heat.buckets) && heat.buckets) || []
  const hotspots = (heat && Array.isArray(heat.hotspots) && heat.hotspots) || []
  if (!hotspots.length || !buckets.some((bucket) => bucket.count > 0)) {
    return '暂未发现明显弹幕热区。'
  }
  const hot = hotspots[0]
  const bucket =
    buckets.find((item) => item.from === hot.from && item.to === hot.to) ||
    buckets.find((item) => item.count === hot.count)
  const topText = bucket && Array.isArray(bucket.top) && bucket.top[0] ? bucket.top[0] : ''
  const range = `${formatClock(hot.from)}–${formatClock(hot.to)}`
  if (!topText) return `弹幕集中在 ${range}。`
  const topic = String(topText)
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim()
    .slice(0, 20)
  return `弹幕集中在 ${range}，讨论最多的是『${topic}』。`
}

// ---------------- 封面 ----------------

async function ensureCoverDir(dir) {
  if (!stateModulePromise) {
    stateModulePromise = import('./state.mjs').catch(() => null)
  }
  const stateModule = await stateModulePromise
  if (stateModule && typeof stateModule.ensureDirs === 'function') {
    try {
      stateModule.ensureDirs()
    } catch {
      // state.mjs 未就绪时忽略，下面自己建目录
    }
  }
  await fs.mkdir(dir, { recursive: true })
}

/**
 * 下载封面到 state/covers/<bvid>.jpg。
 * @returns {Promise<{path:string, bytes:number}|{error:string}>}
 */
export async function downloadCover(jar, params = {}, extra = {}) {
  const { bvid, pic, ...rest } = params || {}
  const opts = { ...rest, ...extra }
  const fetchBytes = opts.fetchBytes || defaultFetchBytes
  const dir = opts.dir || opts.coverDir || COVER_DIR
  if (!bvid) return { error: '缺少 bvid' }
  if (!pic) return { error: '缺少封面地址' }
  const safeBvid = String(bvid).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'
  const file = path.join(dir, `${safeBvid}.jpg`)
  try {
    const data = await fetchBytes(normalizeUrl(pic), {
      jar,
      referer: opts.referer || `https://www.bilibili.com/video/${bvid}`,
    })
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data || [])
    if (!buffer.length) return { error: '封面内容为空' }
    await ensureCoverDir(dir)
    await fs.writeFile(file, buffer)
    return { path: file, bytes: buffer.length }
  } catch (error) {
    return { error: errText(error) }
  }
}

// ---------------- 组合入口 ----------------

/**
 * 把字幕、弹幕热区、封面合并进 candidate.enrich；单个子项失败只记 warning。
 * 为方便 CLI/pick/prompt 直接读，同时把同一份结果挂到 candidate.subtitles /
 * candidate.danmakuHeat / candidate.coverPath（都是 candidate.enrich 的别名）。
 * 字幕匿名通常拿不到：此时 subtitles.available=false、loginRequired=true，仍会放进 candidate。
 * @param {import('./http.mjs').CookieJar} jar
 * @param {object} candidate bili.mjs 的 Candidate
 * @param {object} opts { withSubtitles, withDanmaku, withCover, fetchJson, fetchText, fetchBytes, mixin, buckets, coverDir }
 * @returns {Promise<object>} 同一个 candidate（原地合并），warning 在 candidate.enrichWarnings
 */
export async function enrichVideo(jar, candidate, opts = {}) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TypeError('enrichVideo 需要 candidate 对象')
  }
  const enrich = {
    subtitles: null,
    danmakuHeat: null,
    coverPath: null,
    ...(candidate.enrich && typeof candidate.enrich === 'object' ? candidate.enrich : {}),
  }
  // 兼容只保留了顶层字段的旧候选/旧 state
  if (!enrich.subtitles && candidate.subtitles) enrich.subtitles = candidate.subtitles
  if (!enrich.danmakuHeat && candidate.danmakuHeat) enrich.danmakuHeat = candidate.danmakuHeat
  if (!enrich.coverPath && candidate.coverPath) enrich.coverPath = candidate.coverPath
  const warnings = []
  const bvid = candidate.bvid || ''
  const cid = Number(candidate.cid) || 0
  const duration = Number(opts.duration) || Number(candidate.duration) || 0
  const withSubtitles = opts.withSubtitles === undefined ? !enrich.subtitles : Boolean(opts.withSubtitles)
  const withDanmaku = opts.withDanmaku === undefined ? !enrich.danmakuHeat : Boolean(opts.withDanmaku)
  const withCover = opts.withCover === undefined ? !enrich.coverPath : Boolean(opts.withCover)

  if (withSubtitles) {
    if (!bvid || !cid) {
      warnings.push('缺少 bvid/cid，跳过字幕获取')
    } else {
      try {
        const subtitles = await getSubtitles(jar, { bvid, cid }, opts)
        let text = ''
        if (subtitles.available) {
          const chosen = pickSubtitle(subtitles.subtitles)
          if (chosen) {
            try {
              const lines = await fetchSubtitleText(jar, chosen.url, opts)
              text = toPlainText(lines, { maxChars: 1500 })
            } catch (error) {
              warnings.push(`字幕文本下载失败：${errText(error)}`)
            }
          }
        } else if (subtitles.loginRequired) {
          warnings.push('字幕需要登录：匿名请求返回空字幕列表')
        }
        enrich.subtitles = { ...subtitles, text }
      } catch (error) {
        warnings.push(`字幕获取失败：${errText(error)}`)
      }
    }
  }

  if (withDanmaku) {
    if (!cid) {
      warnings.push('缺少 cid，跳过弹幕获取')
    } else {
      try {
        const danmaku = await getDanmaku(jar, { cid }, opts)
        if (danmaku.error) {
          warnings.push(`弹幕获取失败：${danmaku.error}`)
        } else {
          const heat = danmakuHeat(danmaku, { duration, buckets: opts.buckets ?? 12 })
          heat.summary = summarizeHeat(heat)
          heat.total = danmaku.count
          enrich.danmakuHeat = heat
        }
      } catch (error) {
        warnings.push(`弹幕获取失败：${errText(error)}`)
      }
    }
  }

  if (withCover) {
    const pic = candidate.cover || candidate.pic || ''
    if (!bvid || !pic) {
      warnings.push('缺少 bvid/封面地址，跳过封面下载')
    } else {
      try {
        const cover = await downloadCover(jar, { bvid, pic, dir: opts.coverDir }, opts)
        if (cover.error) warnings.push(`封面下载失败：${cover.error}`)
        else enrich.coverPath = cover.path
      } catch (error) {
        warnings.push(`封面下载失败：${errText(error)}`)
      }
    }
  }

  candidate.enrich = enrich
  // 顶层别名：CLI review 读 candidate.danmakuHeat.summary，pick/prompt 可直接读 subtitles.text
  candidate.subtitles = enrich.subtitles
  candidate.danmakuHeat = enrich.danmakuHeat
  candidate.coverPath = enrich.coverPath
  candidate.enrichWarnings = warnings
  return candidate
}
