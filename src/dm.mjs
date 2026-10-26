// src/dm.mjs — B 站私信：发送、会话列表、消息拉取、只回自己、BV/b23 解析
// 所有接口都必须带 message.bilibili.com 的 Referer/Origin，否则容易 -352/-403。
import { biliFetch, DEFAULT_HEADERS, explainCode, jitter } from './http.mjs'
import { cookiesToJar } from './auth.mjs'

const REFERER = 'https://message.bilibili.com/'
const ORIGIN = 'https://message.bilibili.com'

const SEND_URL = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg'
const SESSIONS_URL = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions'
const MESSAGES_URL = 'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs'
const ACK_URL = 'https://api.vc.bilibili.com/session_svr/v1/session_svr/update_ack'

const DM_TEXT_LIMIT = 500
const DM_TEXT_CUT = 480
const BVID_RE = /BV1[0-9A-Za-z]{9}/

/** 只把私信消息分成四类：文本、分享卡片（msg_type=7）、图片（msg_type=2）、其它 */
function normalizeKind(msgType) {
  if (Number(msgType) === 1) return 'text'
  if (Number(msgType) === 7) return 'share'
  if (Number(msgType) === 2) return 'image'
  return 'other'
}

/** 把 B 站私信错误码翻成人话；-101 明确提示先 login */
function dmErrorText(code, message) {
  const suffix = message ? `：${message}` : ''
  if (Number(code) === -101) return '登录态失效（code=-101）：请先运行 `node src/cli.mjs login` 扫码登录'
  if (Number(code) === -400) return `私信请求参数错误（code=-400）${suffix}`
  if (Number(code) === -403) return `没有私信权限或被风控（code=-403）${suffix}，请降低频率后重试`
  return `私信接口失败（${explainCode(code)}）${suffix}`
}

function tryParseJson(raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || (text[0] !== '{' && text[0] !== '[')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * 连续解析分享卡片常见的「JSON 里套 JSON 字符串」结构：
 * 如 {"content":"{\"jump_url\":...}"}，把内层对象合并到外层，方便取 bvid/title。
 */
function parseContentDeep(raw, depth = 0) {
  if (typeof raw !== 'string' || depth > 3) return raw
  const parsed = tryParseJson(raw)
  if (parsed == null) return raw
  if (typeof parsed === 'string') return parseContentDeep(parsed, depth + 1)
  if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') {
    const nested = tryParseJson(parsed.content)
    if (nested && typeof nested === 'object') return { ...parsed, ...nested }
  }
  return parsed
}

/** 文本消息 content 形如 {"content":"你好"}；解析失败时退回原文 */
function contentText(raw) {
  const parsed = parseContentDeep(raw)
  if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string') return parsed.content
  if (typeof parsed === 'string') return parsed
  return typeof raw === 'string' ? raw : ''
}

/** 抽不到字段时保留原始 content 片段（给 CLI/agent 兜底展示） */
function rawSnippet(raw, max = 200) {
  const text = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw) || ''
  return text.slice(0, max)
}

/** 分享卡片里递归找 BV 号（bvid / jump_url / 任意字符串值） */
function findDeepBvid(value, depth = 0) {
  if (depth > 6 || value == null) return null
  if (typeof value === 'string') {
    const matched = value.match(BVID_RE)
    return matched ? matched[0] : null
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepBvid(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value === 'object') {
    for (const key of ['bvid', 'jump_url', 'url', 'content', 'title', 'desc']) {
      if (value[key] !== undefined) {
        const found = findDeepBvid(value[key], depth + 1)
        if (found) return found
      }
    }
    for (const item of Object.values(value)) {
      const found = findDeepBvid(item, depth + 1)
      if (found) return found
    }
  }
  return null
}

function shareTitle(raw) {
  const parsed = parseContentDeep(raw)
  const obj = parsed && parsed.content && typeof parsed.content === 'object' ? parsed.content : parsed
  if (!obj || typeof obj !== 'object') return ''
  const title = obj.title || obj.desc || obj.head_text || obj.name || ''
  return typeof title === 'string' ? title : ''
}

/**
 * 从图片私信的 content JSON 里找图片地址。
 * B 站图片消息形如 {"url":"https://message.biliimg.com/bfs/im_new/...","width":..,"height":..}
 */
function findImageUrl(raw) {
  const parsed = parseContentDeep(raw)
  const seen = new Set()
  const walk = (value, depth) => {
    if (!value || depth > 3) return ''
    if (typeof value === 'string') {
      const text = value.trim()
      if (/^https?:\/\//i.test(text) && /(message\.biliimg|hdslb|bilivideo)/i.test(text)) return text
      return ''
    }
    if (typeof value !== 'object') return ''
    if (seen.has(value)) return ''
    seen.add(value)
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /^(url|image_url|img_url|origin_url)$/i.test(key) && /^https?:\/\//i.test(item)) {
        return item.trim()
      }
      const found = walk(item, depth + 1)
      if (found) return found
    }
    return ''
  }
  return walk(parsed, 0)
}

/** 会话列表里的最后一条消息摘要 */
function lastMessageText(last) {
  if (!last || typeof last !== 'object') return ''
  const type = Number(last.msg_type) || 0
  if (type === 1) return contentText(last.content)
  if (type === 7 || type === 5 || type === 10 || type === 4) return shareTitle(last.content) || '［分享卡片］'
  if (type === 2) return '［图片］'
  if (type === 6) return '［消息已撤回］'
  if (type === 8) return contentText(last.content) || '［系统消息］'
  return contentText(last.content) || (type ? `［消息类型 ${type}］` : '')
}

/**
 * 构造发送私信的表单（纯函数，方便单测）。
 * @param {{senderUid:number, receiverUid:number, text:string, csrf:string, devId?:string, timestamp?:number}} input
 * @returns {Record<string,string>}
 */
export function buildSendForm({
  senderUid = 0,
  receiverUid = 0,
  text = '',
  csrf = '',
  devId = '',
  timestamp = Date.now(),
} = {}) {
  const form = {
    'msg[sender_uid]': String(senderUid),
    'msg[receiver_id]': String(receiverUid),
    'msg[receiver_type]': '1',
    'msg[msg_type]': '1',
    'msg[content]': JSON.stringify({ content: String(text) }),
    csrf: String(csrf),
    csrf_token: String(csrf),
  }
  // dev_id（buvid3）与 timestamp 是可选字段，有值才带
  if (devId) form['msg[dev_id]'] = String(devId)
  if (timestamp) form['msg[timestamp]'] = String(timestamp)
  return form
}

/**
 * 私信正文限长：超过 500 字符时截到 480 并补 '…'。
 * 按 Unicode 码点切分，避免把 emoji 的代理对切成乱码。
 * @param {string} text
 * @param {{limit?:number, cut?:number}} [opts]
 * @returns {{text:string, truncated:boolean}}
 */
export function clampDmText(text, { limit = DM_TEXT_LIMIT, cut = DM_TEXT_CUT } = {}) {
  const source = String(text == null ? '' : text).trim()
  const chars = Array.from(source)
  if (chars.length <= limit) return { text: source, truncated: false }
  return { text: `${chars.slice(0, cut).join('')}…`, truncated: true }
}

/**
 * 解析 data.session_list。
 * @param {any} resp 完整响应或 data 本身
 * @returns {{talkerId:number, uname:string, lastMsg:string, ts:number, unread:number}[]}
 */
export function parseSessions(resp) {
  const data = resp && resp.data && typeof resp.data === 'object' ? resp.data : resp
  const list = data && Array.isArray(data.session_list) ? data.session_list : []
  return list
    .filter((it) => it && (it.talker_id || it.talker_id === 0))
    .map((it) => {
      const last = it.last_msg && typeof it.last_msg === 'object' ? it.last_msg : {}
      const account = it.account_info && typeof it.account_info === 'object' ? it.account_info : {}
      return {
        talkerId: Number(it.talker_id) || 0,
        uname: String(it.uname || account.name || ''),
        lastMsg: lastMessageText(last),
        ts: Number(last.timestamp) || 0,
        unread: Number(it.unread_count) || 0,
      }
    })
}

/**
 * 解析 data.messages。
 * - 保留 msgType（原始 msg_type）
 * - kind 归一为 text(1) / share(7) / image(2) / other
 * - 文本取 content JSON 的 .content；分享卡片抽 bvid 与标题，抽不到 bvid 时保留 raw 片段；
 *   图片消息抽 imageUrl，text 固定为「[图片]」
 * @param {any} resp 完整响应或 data 本身
 * @returns {{senderUid:number, ts:number, kind:'text'|'share'|'image'|'other', msgType:number, text:string, shareBvid?:string, imageUrl?:string, msgKey:string}[]}
 */
export function parseMessages(resp) {
  const data = resp && resp.data && typeof resp.data === 'object' ? resp.data : resp
  const list = data && Array.isArray(data.messages) ? data.messages : []
  return list
    .map((msg) => {
      const item = msg && typeof msg === 'object' ? msg : {}
      const msgType = Number(item.msg_type) || 0
      const kind = normalizeKind(msgType)
      const content = item.content
      let text = ''
      let shareBvid = null
      let imageUrl = null
      if (kind === 'text') {
        text = contentText(content)
      } else if (kind === 'share') {
        shareBvid = findDeepBvid(content)
        text = shareTitle(content)
        // 分享卡片抽不到 BV 时保留 raw 片段，CLI 仍可展示/二次解析
        if (!shareBvid && !text) text = rawSnippet(content)
      } else if (kind === 'image') {
        imageUrl = findImageUrl(content) || null
        text = '[图片]'
      } else {
        text = contentText(content) || rawSnippet(content)
      }
      const parsed = {
        senderUid: Number(item.sender_uid) || 0,
        ts: Number(item.timestamp) || 0,
        kind,
        msgType,
        text: String(text || ''),
        msgKey: String(item.msg_key || ''),
      }
      if (shareBvid) parsed.shareBvid = shareBvid
      if (imageUrl) parsed.imageUrl = imageUrl
      return parsed
    })
    .sort((a, b) => a.ts - b.ts)
}

/** 拉会话列表（最新 count 个） */
export async function listSessions(cookies, { count = 20 } = {}) {
  const jar = cookiesToJar(cookies)
  const query = new URLSearchParams({
    session_type: '1',
    group_id: '0',
    count: String(count),
  })
  const data = await biliFetch(`${SESSIONS_URL}?${query.toString()}`, {
    jar,
    referer: REFERER,
    origin: ORIGIN,
  })
  if (!data || data.code !== 0) throw new Error(dmErrorText(data && data.code, data && data.message))
  return parseSessions(data)
}

/** 拉某个会话的消息（解析后按时间升序） */
export async function fetchMessages(cookies, { talkerId, size = 20 } = {}) {
  const uid = Number(talkerId) || 0
  if (!uid) throw new Error('fetchMessages 需要 talkerId')
  const jar = cookiesToJar(cookies)
  const query = new URLSearchParams({
    talker_id: String(uid),
    session_type: '1',
    size: String(size),
    build: '0',
    mobi_app: 'web',
  })
  const data = await biliFetch(`${MESSAGES_URL}?${query.toString()}`, {
    jar,
    referer: REFERER,
    origin: ORIGIN,
  })
  if (!data || data.code !== 0) throw new Error(dmErrorText(data && data.code, data && data.message))
  return parseMessages(data)
}

/**
 * 发送私信。失败不抛错，返回 {ok:false, code, error}；-101 明确提示先 login。
 * @param {object} cookies
 * @param {{uid:number, text:string}} input
 * @returns {Promise<{ok:boolean, code:number, msgKey?:string, error?:string, truncated?:boolean}>}
 */
export async function sendDm(cookies, { uid, text } = {}) {
  const receiverUid = Number(uid) || 0
  if (!receiverUid) {
    return { ok: false, code: -400, error: '发送私信需要接收者 uid（--to / config.targetUid）' }
  }
  const { text: body, truncated } = clampDmText(text)
  if (!body) return { ok: false, code: -400, error: '私信内容为空', truncated }

  const jar = cookiesToJar(cookies)
  const form = buildSendForm({
    senderUid: Number(jar.get('DedeUserID')) || 0,
    receiverUid,
    text: body,
    csrf: jar.get('bili_jct') || '',
    devId: jar.get('buvid3') || '',
  })
  let data
  try {
    data = await biliFetch(SEND_URL, { jar, form, referer: REFERER, origin: ORIGIN })
  } catch (error) {
    return { ok: false, code: -1, error: `私信发送请求失败：${error.message}`, truncated }
  }
  if (data && data.code === 0) {
    return {
      ok: true,
      code: 0,
      msgKey: String((data.data && data.data.msg_key) || ''),
      truncated,
    }
  }
  const code = data ? Number(data.code) : -1
  return { ok: false, code, error: dmErrorText(code, data && data.message), truncated }
}

/**
 * 过滤 owner 发来的新消息：文本与分享卡片都放行，其余只计数。
 * @param {object[]} messages
 * @param {{sinceTs?:number, ownerUid:number}} input
 * @returns {{fromOwner:object[], othersCount:number}}
 */
export function filterInboxMessages(messages, { sinceTs = 0, ownerUid } = {}) {
  const owner = Number(ownerUid) || 0
  const since = Number(sinceTs) || 0
  const fromOwner = []
  let othersCount = 0
  for (const msg of messages || []) {
    if (!msg || Number(msg.ts) <= since) continue
    if (Number(msg.senderUid) === owner && (msg.kind === 'text' || msg.kind === 'share')) {
      fromOwner.push(msg)
    } else {
      othersCount += 1
    }
  }
  return { fromOwner, othersCount }
}

/**
 * 只回我自己：在会话列表里找 talker_id === ownerUid 的会话，拉消息后筛出
 * ts > sinceTs 且 sender_uid === ownerUid 的文本/分享卡片。
 * @param {object} cookies
 * @param {{sinceTs?:number, ownerUid:number}} input
 * @returns {Promise<{fromOwner:object[], othersCount:number}>}
 */
export async function inboxNew(cookies, { sinceTs = 0, ownerUid } = {}) {
  const owner = Number(ownerUid) || 0
  if (!owner) throw new Error('inboxNew 需要 ownerUid（你自己的 DedeUserID）')

  const sessions = await listSessions(cookies, { count: 50 })
  const ownSession = sessions.find((it) => it.talkerId === owner)
  if (!ownSession) return { fromOwner: [], othersCount: 0 }

  await jitter()
  const messages = await fetchMessages(cookies, { talkerId: owner, size: 50 })
  return filterInboxMessages(messages, { sinceTs, ownerUid: owner })
}

/**
 * 从文本里抽 BV 号；b23.tv 短链返回 null，另走 resolveB23()。
 * @param {string} text
 * @returns {string|null}
 */
export function extractBvid(text) {
  if (!text) return null
  const matched = String(text).match(BVID_RE)
  return matched ? matched[0] : null
}

/**
 * 解析 b23.tv 短链：跟随重定向，从最终 URL（或落地页 HTML）中抽 BV 号。
 * 非 b23/非 URL 文本原样返回 {url}，不抛错，方便 CLI 对任意私信文本兜底调用。
 * @param {string} url
 * @returns {Promise<{bvid?:string, url:string}>}
 */
export async function resolveB23(url) {
  const target = String(url || '').trim()
  if (!target) return { url: '' }

  const direct = extractBvid(target)
  if (direct) return { bvid: direct, url: target }

  let parsed
  try {
    parsed = new URL(target)
  } catch {
    return { url: target }
  }
  if (!/(^|\.)b23\.tv$/i.test(parsed.hostname)) return { url: target }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: { ...DEFAULT_HEADERS, Referer: 'https://www.bilibili.com/' },
      signal: controller.signal,
    })
    const finalUrl = response.url || target
    let bvid = extractBvid(finalUrl)
    if (!bvid) {
      const html = await response.text()
      bvid = extractBvid(html)
    }
    return bvid ? { bvid, url: finalUrl } : { url: finalUrl }
  } catch (error) {
    const reason = error && error.name === 'AbortError' ? '请求超时' : (error && error.message) || String(error)
    throw new Error(`解析 b23 短链失败：${reason}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把会话标记为已读（可选能力，CLI 可不用）。
 * @param {object} cookies
 * @param {{talkerId:number, ackSeqno?:number}} input
 */
export async function markRead(cookies, { talkerId, ackSeqno = 0 } = {}) {
  const uid = Number(talkerId) || 0
  if (!uid) throw new Error('markRead 需要 talkerId')
  const jar = cookiesToJar(cookies)
  const data = await biliFetch(ACK_URL, {
    jar,
    form: {
      talker_id: String(uid),
      session_type: '1',
      ack_seqno: String(ackSeqno),
    },
    referer: REFERER,
    origin: ORIGIN,
  })
  if (!data || data.code !== 0) throw new Error(dmErrorText(data && data.code, data && data.message))
  return { ok: true, code: 0 }
}
