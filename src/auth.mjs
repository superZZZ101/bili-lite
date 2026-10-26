// src/auth.mjs — B 站登录：nav 校验、扫码登录（终端二维码 + GIF 图片）、cookie 持久化
// 关键点：扫码成功后登录凭证只出现在 poll 响应的 Set-Cookie 里，必须自己解析，不能依赖 fetch 的 cookie 管理。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { biliFetch, CookieJar, DEFAULT_HEADERS, sleep, explainCode } from './http.mjs'
import { ensureBuvid } from './bili.mjs'
import { loadState, saveState, ensureDirs, STATE_DIR } from './state.mjs'

const require = createRequire(import.meta.url)

const NAV_URL = 'https://api.bilibili.com/x/web-interface/nav'
const QR_GENERATE_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate'
const QR_POLL_URL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll'
const BILI_REFERER = 'https://www.bilibili.com/'
const QR_GIF_FILE = path.join(STATE_DIR, 'qrcode.gif')
const QR_SVG_FILE = path.join(STATE_DIR, 'qrcode.svg')
const QR_CELL_SIZE = 8
// qrcode-generator 的 margin 单位是像素；留 4 个模块的 quiet zone，扫码更稳
const QR_MARGIN_PX = QR_CELL_SIZE * 4
const QR_POLL_INTERVAL_MS = 2000
const QR_POLL_TIMEOUT_MS = 180 * 1000

// state.cookies 字段名（SPEC）与浏览器原始 cookie 名的映射
const COOKIE_ALIASES = {
  sessdata: 'SESSDATA',
  biliJct: 'bili_jct',
  dedeUserId: 'DedeUserID',
  buvid3: 'buvid3',
  buvid4: 'buvid4',
}

/** 需要从 state.cookies.raw 里回填的原始 cookie 名 */
const RAW_COOKIE_KEYS = [
  'SESSDATA',
  'bili_jct',
  'DedeUserID',
  'DedeUserID__ckMd5',
  'sid',
  'buvid3',
  'buvid4',
  'buvid_fp',
  'buvid_fp_plain',
  'b_nut',
  'b_lsid',
  '_uuid',
  'CURRENT_FNVAL',
  'CURRENT_QUALITY',
]

let qrcodeLib = null

/** 懒加载本地 vendor 的 qrcode-generator（缺失时给出清晰报错） */
function loadQrcodeLib() {
  if (qrcodeLib) return qrcodeLib
  try {
    qrcodeLib = require('../vendor/qrcode.js')
  } catch (error) {
    throw new Error(`加载 vendor/qrcode.js 失败（二维码无法生成）：${error.message}`)
  }
  if (typeof qrcodeLib !== 'function') throw new Error('vendor/qrcode.js 导出异常：应为 qrcode 函数')
  return qrcodeLib
}

function unquote(value) {
  const text = String(value == null ? '' : value)
  return text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text
}

/**
 * 把 state.cookies / CookieJar / 原始 cookie 对象统一成 CookieJar。
 * @param {object|CookieJar|null|undefined} cookies
 * @returns {CookieJar}
 */
export function cookiesToJar(cookies) {
  if (cookies instanceof CookieJar) return cookies
  if (cookies && typeof cookies.toObject === 'function' && typeof cookies.get === 'function') {
    return new CookieJar(cookies.toObject())
  }
  const out = {}
  if (cookies && typeof cookies === 'object') {
    if (cookies.raw && typeof cookies.raw === 'object') Object.assign(out, cookies.raw)
    for (const key of RAW_COOKIE_KEYS) {
      if (cookies[key] != null && cookies[key] !== '') out[key] = unquote(cookies[key])
    }
    for (const [alias, name] of Object.entries(COOKIE_ALIASES)) {
      if (cookies[alias] != null && cookies[alias] !== '') out[name] = unquote(cookies[alias])
    }
  }
  return new CookieJar(out)
}

/**
 * 校验登录态（GET nav）。没有 SESSDATA 时直接返回未登录，不发请求。
 * @param {object|CookieJar|null} cookies
 * @returns {Promise<{isLogin:boolean, uid?:number, uname?:string, face?:string, reason?:string}>}
 */
export async function checkLogin(cookies) {
  const jar = cookiesToJar(cookies)
  if (!jar.get('SESSDATA')) {
    return { isLogin: false, reason: '本地没有 SESSDATA，尚未登录' }
  }
  let data
  try {
    data = await biliFetch(NAV_URL, { jar, referer: BILI_REFERER })
  } catch (error) {
    return { isLogin: false, reason: `登录态校验请求失败：${error.message}` }
  }
  const info = (data && data.data) || {}
  if (data && data.code === 0 && (info.isLogin === true || Number(info.isLogin) === 1)) {
    return {
      isLogin: true,
      uid: Number(info.mid) || 0,
      uname: info.uname || '',
      face: info.face || '',
      level: Number(info.level_info && info.level_info.current_level) || 0,
    }
  }
  return {
    isLogin: false,
    uid: Number(info.mid) || 0,
    uname: info.uname || '',
    reason: data && data.code !== 0 ? explainCode(data.code) : '登录态已失效（nav.isLogin=false）',
    code: data ? data.code : -1,
    message: (data && data.message) || '',
  }
}

/** 从 state 读取 cookies 构造 CookieJar，并顺手补齐 buvid（失败不阻塞） */
export async function getJar() {
  const jar = cookiesToJar(loadState().cookies)
  try {
    await ensureBuvid(jar)
  } catch {
    /* 补 buvid 失败不影响多数匿名接口 */
  }
  return jar
}

/** 由 qrcode 实例生成布尔矩阵（true=深色模块） */
function matrixFromQr(qr) {
  const count = qr.getModuleCount()
  const rows = []
  for (let r = 0; r < count; r++) {
    const row = new Array(count)
    for (let c = 0; c < count; c++) row[c] = Boolean(qr.isDark(r, c))
    rows.push(row)
  }
  return rows
}

function makeQr(text) {
  if (!text) throw new Error('二维码内容为空')
  const qrcode = loadQrcodeLib()
  const qr = qrcode(0, 'M')
  qr.addData(String(text))
  qr.make()
  return qr
}

/**
 * 生成二维码矩阵（纯函数，测试用）。
 * @param {string} text
 * @returns {boolean[][]}
 */
export function buildQrMatrix(text) {
  return matrixFromQr(makeQr(text))
}

/**
 * 终端渲染：quiet zone 2 个模块，深色 '██'、浅色 '  '。
 * @param {boolean[][]} rows
 * @param {{quiet?:number, out?:(line:string)=>void}} [opts]
 */
export function renderQrTerminal(rows, { quiet = 2, out = console.log } = {}) {
  const count = rows.length
  const padding = '  '.repeat(quiet)
  const blank = '  '.repeat(count + quiet * 2)
  for (let i = 0; i < quiet; i++) out(blank)
  for (let r = 0; r < count; r++) {
    let line = padding
    for (let c = 0; c < count; c++) line += rows[r][c] ? '██' : '  '
    out(line + padding)
  }
  for (let i = 0; i < quiet; i++) out(blank)
}

/** 把二维码写成 state/qrcode.gif；GIF 失败时退回 state/qrcode.svg */
function writeQrImage(qr) {
  ensureDirs()
  let gifError = ''
  try {
    const dataUrl = String(qr.createDataURL(QR_CELL_SIZE, QR_MARGIN_PX))
    const comma = dataUrl.indexOf(',')
    if (comma < 0) throw new Error('createDataURL 未返回 data URL')
    const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64')
    if (buffer.length <= 500) throw new Error(`GIF 体积异常（${buffer.length} 字节）`)
    fs.writeFileSync(QR_GIF_FILE, buffer)
    return { qrPath: QR_GIF_FILE, format: 'gif' }
  } catch (error) {
    gifError = error.message
  }
  const svg = qr.createSvgTag(QR_CELL_SIZE, QR_MARGIN_PX)
  if (!svg || !String(svg).includes('<svg')) throw new Error(`二维码图片生成失败：${gifError}`)
  fs.writeFileSync(QR_SVG_FILE, svg, 'utf8')
  return { qrPath: QR_SVG_FILE, format: 'svg', warning: `GIF 生成失败（${gifError}），已退回 SVG` }
}

/**
 * 只生成二维码（不轮询），便于 CLI/测试单独使用。
 * @param {{show?:boolean}} [opts]
 * @returns {Promise<{url:string, qrcodeKey:string, matrix:boolean[][], qrPath:string}>}
 */
export async function generateQr({ show = true } = {}) {
  const resp = await biliFetch(QR_GENERATE_URL, { headers: { Referer: BILI_REFERER } })
  if (!resp || resp.code !== 0 || !resp.data || !resp.data.url) {
    const code = resp ? resp.code : '?'
    throw new Error(`获取登录二维码失败：${(resp && resp.message) || '未知错误'}（code=${code}）`)
  }
  const { url, qrcode_key: qrcodeKey } = resp.data
  const qr = makeQr(url)
  const matrix = matrixFromQr(qr)
  const image = writeQrImage(qr)
  if (show) {
    renderQrTerminal(matrix)
    console.log('')
    console.log(`二维码内容：${url}`)
    console.log(`二维码图片：${image.qrPath}`)
    console.log('请用手机 B 站 App 扫码登录；也可把上面的图片转存/预览后再扫。')
    if (image.warning) console.log(`提示：${image.warning}`)
    if (!process.stdout.isTTY) console.log('（当前不是交互终端：只打印链接与图片路径，不等待键盘输入）')
  }
  return { url, qrcodeKey, matrix, qrPath: image.qrPath }
}

/**
 * 解析轮询响应。注意：业务码在 data.code（86101/86090/0/86038），不是顶层 code。
 * @param {any} resp
 * @returns {{status:string, code:number, topCode:number, message:string, url:string, refreshToken:string, timestamp:number}}
 */
export function parseQrPoll(resp) {
  const top = resp && typeof resp === 'object' ? resp : {}
  const data = top.data && typeof top.data === 'object' ? top.data : {}
  const rawCode = Number(data.code)
  const code = Number.isFinite(rawCode) ? rawCode : -1
  const statusMap = { 86101: 'waiting', 86090: 'scanned', 0: 'success', 86038: 'expired' }
  let status = statusMap[code] || 'unknown'
  if (top.code !== undefined && Number(top.code) !== 0) status = 'error'
  return {
    status,
    code,
    topCode: Number(top.code),
    message: data.message || top.message || '',
    url: data.url || '',
    refreshToken: data.refresh_token || '',
    timestamp: Number(data.timestamp) || 0,
  }
}

/**
 * 从 Set-Cookie 行数组提取 cookie 键值（只取 name=value，忽略属性）。
 * @param {string[]} lines
 * @returns {Record<string,string>}
 */
export function parseSetCookies(lines) {
  const out = {}
  for (const line of lines || []) {
    if (!line) continue
    const pair = String(line).split(';')[0]
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const name = pair.slice(0, idx).trim()
    const value = unquote(pair.slice(idx + 1).trim())
    if (!name || value === '' || /^(deleted|delete)$/i.test(value)) continue
    out[name] = value
  }
  return out
}

/**
 * 兜底：从 poll 返回的 data.url（crossDomain 跳转地址）里抽 cookie 参数。
 * 不解码 value —— SESSDATA 里的 %2C 必须原样保留。
 * @param {string} url
 * @returns {Record<string,string>}
 */
export function parseCookieUrl(url) {
  const out = {}
  const query = String(url || '').split('?')[1] || ''
  for (const part of query.split('&')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx)
    if (!key || key === 'gourl' || key === 'Expires') continue
    out[key] = unquote(part.slice(idx + 1))
  }
  return out
}

/**
 * 把原始 cookie 映射成 SPEC 规定的 state.cookies（原始值保留在 raw）。
 * @param {Record<string,string>} raw
 * @param {{uid?:number}} [opts]
 */
export function buildCookieState(raw, { uid = 0 } = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  return {
    sessdata: source.SESSDATA || '',
    biliJct: source.bili_jct || '',
    dedeUserId: Number(source.DedeUserID) || Number(uid) || 0,
    buvid3: source.buvid3 || '',
    buvid4: source.buvid4 || '',
    savedAt: new Date().toISOString(),
    raw: { ...source },
  }
}

function notLoggedInError(detail = '') {
  const error = new Error(
    `未登录${detail ? `：${detail}` : ''}。请先运行 \`node src/cli.mjs login\` 扫码登录（或调用 qrLogin()）`,
  )
  error.code = 'NOT_LOGGED_IN'
  return error
}

/**
 * 有缓存且 nav 校验通过则复用，否则抛出带 login 提示的错误（由 CLI 决定是否交互扫码）。
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{cookies:object, uid:number}>}
 */
export async function ensureLogin({ force = false } = {}) {
  const state = loadState()
  if (force) throw notLoggedInError('已指定 --force，需要重新扫码')
  if (!state.cookies) throw notLoggedInError('本地没有登录凭证')
  const info = await checkLogin(state.cookies)
  if (info.isLogin) return { cookies: state.cookies, uid: info.uid }
  throw notLoggedInError(info.reason || '登录态已失效')
}

/** 轮询一次二维码状态（直接 fetch，保留 Set-Cookie） */
async function pollQrOnce(qrcodeKey) {
  const query = new URLSearchParams({ qrcode_key: qrcodeKey, source: 'main-fe-header' })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(`${QR_POLL_URL}?${query.toString()}`, {
      method: 'GET',
      headers: {
        ...DEFAULT_HEADERS,
        Referer: BILI_REFERER,
        Origin: 'https://passport.bilibili.com',
      },
      signal: controller.signal,
    })
    const setCookies =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : response.headers.get('set-cookie')
          ? [response.headers.get('set-cookie')]
          : []
    let json = null
    try {
      json = await response.json()
    } catch {
      json = { code: -1, message: `轮询响应不是 JSON（HTTP ${response.status}）` }
    }
    return { json, setCookies }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 扫码登录全流程：生成二维码 → 终端/图片展示 → 轮询 → 校验 → 写入 state。
 * @param {{onQr?:(info:{url:string, qrPath:string, qrcodeKey:string, matrix:boolean[][]}) => any}} [opts]
 * @returns {Promise<{cookies:object, uid:number, qrPath:string}>}
 */
export async function qrLogin({ onQr } = {}) {
  const qr = await generateQr({ show: true })
  if (typeof onQr === 'function') {
    try {
      await onQr({ url: qr.url, qrPath: qr.qrPath, qrcodeKey: qr.qrcodeKey })
    } catch (error) {
      console.warn(`onQr 回调失败（忽略）：${error.message}`)
    }
  }

  const deadline = Date.now() + QR_POLL_TIMEOUT_MS
  let scanned = false
  let lastError = ''
  console.log('等待扫码…')

  while (Date.now() < deadline) {
    let result
    try {
      result = await pollQrOnce(qr.qrcodeKey)
    } catch (error) {
      // 网络抖动不中断，继续轮询到超时
      lastError = error && error.name === 'AbortError' ? '轮询超时' : (error && error.message) || String(error)
      if (Date.now() < deadline) await sleep(QR_POLL_INTERVAL_MS)
      continue
    }
    const parsed = parseQrPoll(result.json)
    if (parsed.status === 'scanned' && !scanned) {
      scanned = true
      console.log('已扫码，请在手机 B 站 App 上点击确认…')
    }
    if (parsed.status === 'expired') {
      throw new Error('二维码已过期：请重新运行 login 生成新的二维码')
    }
    if (parsed.status === 'error') {
      throw new Error(`轮询登录状态失败：${parsed.message || '未知错误'}（code=${parsed.topCode}）`)
    }
    if (parsed.status === 'success') {
      // 登录凭证在 Set-Cookie 里；data.url 里的 query 仅作兜底（Set-Cookie 优先）
      const fromUrl = parseCookieUrl(parsed.url)
      const fromSetCookie = parseSetCookies(result.setCookies)
      const raw = { ...fromUrl, ...fromSetCookie }
      if (!raw.SESSDATA) {
        throw new Error('扫码成功但响应中没有 SESSDATA（可能被风控）：请重试')
      }
      const cookies = buildCookieState(raw)
      const info = await checkLogin(cookies)
      if (!info.isLogin) {
        throw new Error(`扫码成功但登录态校验失败：${info.reason || '未知原因'}，请重试`)
      }
      const uid = info.uid || Number(raw.DedeUserID) || 0
      cookies.dedeUserId = uid
      const state = loadState()
      state.cookies = cookies
      if (!state.config.targetUid && uid) state.config.targetUid = uid
      saveState(state)
      console.log(`登录成功：${info.uname || '(未取名)'}（uid=${uid}）`)
      console.log(`登录态已保存到 state/state.json：${state.cookies.savedAt}`)
      return { cookies, uid, qrPath: qr.qrPath }
    }
    if (Date.now() < deadline) await sleep(QR_POLL_INTERVAL_MS)
  }
  throw new Error(`扫码登录超时（${QR_POLL_TIMEOUT_MS / 1000}s）${lastError ? `：${lastError}` : ''}`)
}
