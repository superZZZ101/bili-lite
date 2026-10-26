// src/http.mjs — CookieJar + B 站请求封装（零依赖）
// 注意：所有请求必须带 UA 与 Referer，否则 B 站风控会返回 -352/-412。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export const DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.bilibili.com/',
}

export class CookieJar {
  constructor(initial = {}) {
    this.map = new Map(Object.entries(initial || {}).filter(([, v]) => v != null))
  }
  set(k, v) {
    if (!k) return
    this.map.set(k, v)
  }
  get(k) {
    return this.map.get(k)
  }
  has(k) {
    return this.map.has(k)
  }
  toObject() {
    return Object.fromEntries(this.map)
  }
  /** 供请求头使用的 Cookie 字符串 */
  header() {
    return [...this.map].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  /** 合并常见登录态字段 */
  static fromCookies(cookies) {
    return new CookieJar(cookies || {})
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 请求间随机等待，降低风控概率 */
export function jitter(min = 300, max = 900) {
  return sleep(min + Math.floor(Math.random() * Math.max(1, max - min)))
}

function absorbSetCookie(jar, response) {
  if (!jar) return
  const raw =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : response.headers.get('set-cookie')
        ? [response.headers.get('set-cookie')]
        : []
  for (const line of raw) {
    if (!line) continue
    const first = String(line).split(',')[0] === String(line) ? String(line) : String(line)
    const pair = first.split(';')[0]
    const idx = pair.indexOf('=')
    if (idx <= 0) continue
    const name = pair.slice(0, idx).trim()
    const value = pair.slice(idx + 1).trim()
    if (!name) continue
    // 删除型 cookie
    if (value === '' || /^(deleted|delete)$/i.test(value)) {
      jar.map.delete(name)
      continue
    }
    jar.set(name, value)
  }
}

/**
 * 发起 B 站请求并返回解析后的 JSON（非 JSON 时返回文本）。
 * @param {string} url
 * @param {{method?:string, jar?:CookieJar, form?:Record<string,any>, body?:string, json?:any, headers?:Record<string,string>, timeoutMs?:number, referer?:string, origin?:string}} opts
 */
export async function biliFetch(url, opts = {}) {
  const {
    method = opts.json || opts.form || opts.body ? 'POST' : 'GET',
    jar,
    form,
    json,
    body,
    headers = {},
    timeoutMs = 20000,
    referer,
    origin,
  } = opts

  const finalHeaders = { ...DEFAULT_HEADERS, ...headers }
  if (referer) finalHeaders.Referer = referer
  if (origin) finalHeaders.Origin = origin
  if (jar && jar.header()) finalHeaders.Cookie = jar.header()

  let payload = body
  if (form) {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(form)) {
      if (v === undefined || v === null) continue
      params.append(k, typeof v === 'string' ? v : JSON.stringify(v))
    }
    payload = params.toString()
    finalHeaders['Content-Type'] = 'application/x-www-form-urlencoded'
  } else if (json !== undefined) {
    payload = JSON.stringify(json)
    finalHeaders['Content-Type'] = 'application/json'
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
    })
  } catch (error) {
    clearTimeout(timer)
    const reason =
      error && error.name === 'AbortError'
        ? `超时（${timeoutMs}ms）`
        : (error && error.message) || String(error)
    throw new Error(`请求失败 ${url}: ${reason}`)
  }
  clearTimeout(timer)
  absorbSetCookie(jar, response)

  const text = await response.text()
  if (!text) return { code: -1, message: '空响应', _status: response.status, _url: url }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed._status === undefined) parsed._status = response.status
      if (parsed._url === undefined) parsed._url = url
    }
    return parsed
  } catch {
    return { code: -1, message: text.slice(0, 300), _status: response.status, _url: url, _raw: true }
  }
}

/** 把 B 站错误码翻译成人话 */
export function explainCode(code) {
  const map = {
    '-101': '账号未登录（需要先 login，或登录态已过期）',
    '-352': '风控校验失败（请求头/签名不对，或触发频率限制，稍后重试）',
    '-412': '被 B 站风控拦截（请求过密，等几分钟再试）',
    '-400': '请求参数错误',
    '-403': '访问权限不足（可能需要登录/签名）',
    '-404': '资源不存在',
    '-509': '请求过于频繁（限流）',
    '-626': '账号被限制',
  }
  return map[String(code)] || `B 站返回错误码 ${code}`
}

/** 断言业务码为 0，否则抛出带解释的错误 */
export function assertOk(data, label = 'B 站接口') {
  if (!data || data.code !== 0) {
    const code = data ? data.code : '?'
    throw new Error(`${label}失败：${data && data.message ? data.message : '未知'}（code=${code}，${explainCode(code)}）`)
  }
  return data.data
}
