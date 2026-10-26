// src/wbi.mjs — B 站 WBI 签名（2024 版算法：img_key+sub_key 混排后取前 32 位作 mixin key）
import crypto from 'node:crypto'

const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let cache = { at: 0, keys: null }

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex')

function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] || '')
    .join('')
    .slice(0, 32)
}

function pickKeyFromUrl(url) {
  if (!url) return ''
  const tail = String(url).split('/').pop() || ''
  return tail.replace(/\.(png|webp|jpg)$/i, '')
}

/**
 * 获取（并缓存）WBI 密钥。
 * @param {import('./http.mjs').CookieJar} jar
 */
export async function getWbiKeys(jar) {
  const now = Date.now()
  if (cache.keys && now - cache.at < 30 * 60 * 1000) return cache.keys
  const { biliFetch } = await import('./http.mjs')
  // 注意：未登录时 nav 返回 code=-101（账号未登录），但 data.wbi_img 仍然有效，
  // 所以这里不能 assertOk，只要 data.wbi_img 存在就用。
  const raw = await biliFetch('https://api.bilibili.com/x/web-interface/nav', { jar })
  const data = (raw && raw.data) || {}
  const wbi = data.wbi_img || {}
  if (!wbi.img_url || !wbi.sub_url) {
    throw new Error(
      `获取 WBI 密钥失败：nav 未返回 wbi_img（code=${raw && raw.code}，${raw && raw.message}）`,
    )
  }
  const imgKey = pickKeyFromUrl(wbi.img_url)
  const subKey = pickKeyFromUrl(wbi.sub_url)
  if (!imgKey || !subKey) throw new Error('获取 WBI 密钥失败：nav 接口未返回 wbi_img')
  const keys = { imgKey, subKey, mixin: mixinKey(imgKey, subKey) }
  cache = { at: now, keys }
  return keys
}

/** 清除缓存（测试用） */
export function resetWbiCache() {
  cache = { at: 0, keys: null }
}

function encodeValue(v) {
  // WBI 要求过滤 !'()* 这些字符
  return encodeURIComponent(String(v).replace(/[!'()*]/g, ''))
}

/**
 * 生成带 wts / w_rid 的查询串（参数会按 key 排序）。
 * @param {Record<string, any>} params
 * @param {string} mixin
 */
export function signWbi(params, mixin) {
  if (!mixin) throw new Error('signWbi 需要 mixin key')
  const signed = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(signed)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeValue(signed[k])}`)
    .join('&')
  return `${query}&w_rid=${md5(query + mixin)}`
}

/** 直接返回带签名的 URL */
export function signedUrl(baseUrl, params, mixin) {
  return `${baseUrl}?${signWbi(params, mixin)}`
}
