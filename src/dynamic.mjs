// src/dynamic.mjs — 发 B 站动态（文字 / 图片 / 视频分享）
//
// 动态替代签名：公开、可被发现、不解释。
// 规则：
//   - 每天最多 3 条（技术护栏），实际看心情；
//   - 只用「不含主人隐私」的信息：公开日记、印象、她自己的心情、视频/评论；
//   - 不能带主人私聊、主人个人信息、提到主人的私密日记；
//   - 图片只允许视频封面/截图；禁止 inbox-images / diary 里的图；
//   - 评论 / 弹幕仍然禁止。
import fs from 'node:fs'
import path from 'node:path'

import { biliFetch, DEFAULT_HEADERS } from './http.mjs'
import { loadState, STATE_DIR } from './state.mjs'
import { cookiesToJar } from './auth.mjs'
import { videoDetail } from './bili.mjs'

const REFERER = 'https://t.bilibili.com/'
const ORIGIN = 'https://t.bilibili.com'
const UPLOAD_URL = 'https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs'
const CREATE_URL = 'https://api.bilibili.com/x/dynamic/feed/create/dyn'
const OLD_CREATE_URL = 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/create'
const DELETE_URL = 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic'
const MAX_IMAGES = 9
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function currentContext() {
  const state = loadState()
  const jar = cookiesToJar(state.cookies)
  const csrf =
    (state.cookies && (state.cookies.biliJct || state.cookies.raw?.bili_jct)) || jar.get('bili_jct')
  const mid = String((state.cookies && state.cookies.DedeUserID) || jar.get('DedeUserID') || '')
  return { state, jar, csrf, mid }
}

/** 粗略的隐私检查：主人的 uid、cookie/key、和「提到主人」的私密日记长重合 */
export function checkDynamicPrivacy(text, { diaryDir } = {}) {
  const source = String(text || '')
  const warnings = []
  const state = loadState()
  const ownerUid = String((state.config && state.config.targetUid) || '')
  if (ownerUid && source.includes(ownerUid)) {
    return { ok: false, warnings: ['正文里出现了主人的 uid'] }
  }
  if (/SESSDATA|bili_jct|DedeUserID|sk-[A-Za-z0-9]{8,}/i.test(source)) {
    return { ok: false, warnings: ['正文里像是有 cookie / API key'] }
  }
  if (source.length > 2000) warnings.push('动态太长了，公开内容建议短一点。')
  // 和「提到主人」的私密日记重合太多，拦一下
  try {
    const file = path.join(diaryDir || path.join(path.dirname(STATE_DIR), 'diary'), 'private.md')
    const diary = fs.readFileSync(file, 'utf8')
    const chunks = diary.split(/\n{2,}/).filter((chunk) => chunk.includes('主人') && chunk.length > 20)
    for (const chunk of chunks) {
      const common = longestCommonSubstring(source, chunk)
      if (common.length >= 14) {
        return {
          ok: false,
          warnings: [`和提到主人的私密日记有 ${common.length} 字重合：「${common.slice(0, 24)}」`],
        }
      }
    }
  } catch {
    /* 没有私密日记就算了 */
  }
  return { ok: true, warnings }
}

/** 图片路径的硬边界：不碰主人私信图片 / 私密日记 */
export function checkImagePath(filePath) {
  const abs = path.resolve(String(filePath || ''))
  if (!fs.existsSync(abs)) return { ok: false, error: `图片不存在：${abs}` }
  const ext = path.extname(abs).toLowerCase()
  if (!['.png', '.jpg', '.jpeg', '.gif'].includes(ext)) {
    return { ok: false, error: `图片格式只支持 png/jpg/jpeg/gif：${ext}` }
  }
  const stat = fs.statSync(abs)
  if (stat.size > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 20MB' }
  if (stat.size < 1024) return { ok: false, error: '图片太小（<1KB），B 站可能拒收' }
  const home = path.resolve(path.dirname(STATE_DIR))
  const blocked = [path.join(home, 'state', 'inbox-images'), path.join(home, 'diary')]
  if (blocked.some((dir) => abs.toLowerCase().startsWith(`${dir.toLowerCase()}${path.sep}`))) {
    return { ok: false, error: '不允许发主人私信图片或日记里的图' }
  }
  return { ok: true, file: abs, size: stat.size, ext }
}

function longestCommonSubstring(a, b) {
  const s1 = String(a || '')
  const s2 = String(b || '')
  let best = ''
  let prev = new Array(s2.length + 1).fill(0)
  for (let i = 1; i <= s1.length; i++) {
    const cur = new Array(s2.length + 1).fill(0)
    for (let j = 1; j <= s2.length; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best.length) best = s1.slice(i - cur[j], i)
      }
    }
    prev = cur
  }
  return best
}

function mimeOf(ext) {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

/** 上传一张图片到 B 站动态图床 */
export async function uploadDynamicImage(filePath, { jar, csrf } = {}) {
  const checked = checkImagePath(filePath)
  if (!checked.ok) return { ok: false, code: -1, message: checked.error }
  const ctx = jar && csrf ? { jar, csrf } : currentContext()
  if (!ctx.csrf) return { ok: false, code: -101, message: '缺少 bili_jct（csrf），请先 login' }
  const buffer = fs.readFileSync(checked.file)
  const form = new FormData()
  form.append('file_up', new Blob([buffer], { type: mimeOf(checked.ext) }), path.basename(checked.file))
  form.append('category', 'daily')
  form.append('csrf', ctx.csrf)
  let response
  try {
    response = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        Referer: REFERER,
        Origin: ORIGIN,
        Cookie: ctx.jar.header(),
      },
      body: form,
      signal: AbortSignal.timeout(90_000),
    })
  } catch (error) {
    return { ok: false, code: -1, message: `图片上传失败：${error.message}` }
  }
  let data
  try {
    data = await response.json()
  } catch {
    return { ok: false, code: -1, message: `图片上传响应非 JSON（HTTP ${response.status}）` }
  }
  const code = Number(data && data.code)
  if (code !== 0) return { ok: false, code, message: (data && (data.message || data.msg)) || '' }
  const info = data.data || {}
  return {
    ok: true,
    code,
    image_url: info.image_url,
    image_width: Number(info.image_width) || 0,
    image_height: Number(info.image_height) || 0,
    img_size: Number(info.img_size) || Math.round((checked.size / 1024) * 10) / 10,
    file: checked.file,
  }
}

async function createJsonDynamic(dynReq, { jar, csrf }) {
  let response
  try {
    response = await fetch(`${CREATE_URL}?csrf=${encodeURIComponent(csrf)}`, {
      method: 'POST',
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        'Content-Type': 'application/json',
        Referer: REFERER,
        Origin: ORIGIN,
        Cookie: jar.header(),
      },
      body: JSON.stringify({ dyn_req: dynReq }),
      signal: AbortSignal.timeout(60_000),
    })
  } catch (error) {
    return { ok: false, code: -1, message: `动态请求失败：${error.message}` }
  }
  let data
  try {
    data = await response.json()
  } catch {
    return { ok: false, code: -1, message: `动态响应非 JSON（HTTP ${response.status}）` }
  }
  const code = Number(data && data.code)
  if (code !== 0) return { ok: false, code, message: (data && (data.message || data.msg)) || '' }
  const info = data.data || {}
  return {
    ok: true,
    code,
    dynamicId: String(info.dyn_id_str || info.dyn_id || ''),
    dynType: Number(info.dyn_type) || 0,
    endpoint: 'create/dyn',
  }
}

/**
 * 发一条纯文字动态（旧接口最稳）。
 * @param {string} text
 * @param {{dryRun?:boolean}} opts
 */
async function postTextDynamic(text, { dryRun = true } = {}) {
  if (dryRun) return { ok: true, dryRun: true, text, kind: 'text' }
  const { jar, csrf } = currentContext()
  if (!csrf) return { ok: false, code: -101, message: '缺少 bili_jct（csrf），请先 login' }
  const data = await biliFetch(OLD_CREATE_URL, {
    jar,
    form: {
      dynamic_id: 0,
      type: 4,
      rid: 0,
      content: text,
      up_choose_comment: 0,
      up_close_comment: 0,
      csrf,
      csrf_token: csrf,
    },
    referer: REFERER,
    origin: ORIGIN,
  })
  const code = Number(data && data.code)
  if (code !== 0) return { ok: false, code, message: (data && data.message) || '', endpoint: 'old-text' }
  const info = data.data || {}
  return {
    ok: true,
    code,
    dynamicId: String(info.dynamic_id_str || info.dynamic_id || ''),
    dynType: Number(info.dyn_type) || 4,
    endpoint: 'old-text',
    kind: 'text',
  }
}

/**
 * 文字 + 图片动态（先上传到 B 站图床）。
 * @param {string} text
 * @param {string[]} images 1~9 个本地图片
 */
export async function postImageDynamic(text, images, { dryRun = true } = {}) {
  const list = (Array.isArray(images) ? images : [images]).filter(Boolean).slice(0, MAX_IMAGES)
  if (!list.length) return { ok: false, code: -400, message: '没有图片' }
  if (dryRun) return { ok: true, dryRun: true, text, images: list, kind: 'image' }
  const { jar, csrf } = currentContext()
  if (!csrf) return { ok: false, code: -101, message: '缺少 bili_jct（csrf），请先 login' }
  const uploaded = []
  for (const file of list) {
    const result = await uploadDynamicImage(file, { jar, csrf })
    if (!result.ok) return { ok: false, stage: 'upload', ...result, file }
    uploaded.push(result)
  }
  const dynReq = {
    content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
    pics: uploaded.map((item) => ({
      img_src: item.image_url,
      img_width: item.image_width,
      img_height: item.image_height,
      img_size: item.img_size,
    })),
    scene: 2,
    meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
  }
  const result = await createJsonDynamic(dynReq, { jar, csrf })
  return { ...result, kind: 'image', images: uploaded.map((item) => item.image_url) }
}

/**
 * 视频分享动态（B 站原生卡片，自带封面）。
 * @param {string} bvid
 * @param {string} text
 */
export async function postVideoDynamic(bvid, text, { dryRun = true } = {}) {
  const id = String(bvid || '').trim()
  if (!/^BV[0-9A-Za-z]+$/.test(id)) return { ok: false, code: -400, message: `bvid 不合法：${bvid}` }
  if (dryRun) return { ok: true, dryRun: true, text, bvid: id, kind: 'video' }
  const { jar, csrf } = currentContext()
  if (!csrf) return { ok: false, code: -101, message: '缺少 bili_jct（csrf），请先 login' }
  let video
  try {
    video = await videoDetail(jar, id)
  } catch (error) {
    return { ok: false, code: -1, message: `拿不到视频详情：${error.message}` }
  }
  if (!video || !video.aid) return { ok: false, code: -1, message: `拿不到 ${id} 的 aid` }
  const data = await biliFetch(OLD_CREATE_URL, {
    jar,
    form: {
      dynamic_id: 0,
      type: 8,
      rid: Number(video.aid),
      content: text,
      up_choose_comment: 0,
      up_close_comment: 0,
      csrf,
      csrf_token: csrf,
    },
    referer: REFERER,
    origin: ORIGIN,
  })
  const code = Number(data && data.code)
  if (code !== 0) {
    return {
      ok: false,
      code,
      message: (data && data.message) || '',
      endpoint: 'old-video',
      bvid: id,
      aid: Number(video.aid),
    }
  }
  const info = data.data || {}
  return {
    ok: true,
    code,
    dynamicId: String(info.dynamic_id_str || info.dynamic_id || ''),
    dynType: Number(info.dyn_type) || 8,
    endpoint: 'old-video',
    bvid: id,
    aid: Number(video.aid),
    title: video.title || '',
  }
}

/** 删除自己的动态（测试/误发时用） */
export async function deleteDynamic(dynamicId, { dryRun = false } = {}) {
  const id = String(dynamicId || '').trim()
  if (!id) return { ok: false, code: -400, message: '缺少 dynamicId' }
  if (dryRun) return { ok: true, dryRun: true, dynamicId: id }
  const { jar, csrf } = currentContext()
  if (!csrf) return { ok: false, code: -101, message: '缺少 bili_jct（csrf），请先 login' }
  const data = await biliFetch(DELETE_URL, {
    jar,
    form: { dynamic_id: id, csrf },
    referer: REFERER,
    origin: ORIGIN,
  })
  const code = Number(data && data.code)
  return { ok: code === 0, code, message: (data && data.message) || '', dynamicId: id }
}

/**
 * 统一入口：纯文字 / 图片 / 带视频链接的文字（`--bvid` 自动把链接写进正文）。
 * 原生的视频卡片接口（type=8）已经不可用，所以视频动态走「文字 + 链接」，B 站会把链接渲染成卡片。
 * @param {string} text
 * @param {{dryRun?:boolean, bvid?:string, image?:string, images?:string[]}} opts
 */
export async function postDynamic(text, { dryRun = true, bvid = '', image = '', images = [] } = {}) {
  const body = String(text || '').trim()
  if (!body) return { ok: false, code: -400, message: '动态内容为空' }
  if (body.length > 2000) return { ok: false, code: -400, message: '动态太长（>2000 字）' }
  const list = [image, ...(Array.isArray(images) ? images : [])].filter(Boolean)
  const id = String(bvid || '').trim()
  if (id && !/^BV[0-9A-Za-z]+$/.test(id)) return { ok: false, code: -400, message: `bvid 不合法：${bvid}` }
  if (id && list.length) return { ok: false, code: -400, message: '视频链接和图片不能同时带' }
  if (id) {
    const link = `https://www.bilibili.com/video/${id}`
    const content = body.includes(id) ? body : `${body}\n${link}`
    if (content.length > 2000) return { ok: false, code: -400, message: '动态太长（>2000 字）' }
    const result = await postTextDynamic(content, { dryRun })
    return { ...result, kind: 'text-link', bvid: id, link }
  }
  if (list.length) return postImageDynamic(body, list, { dryRun })
  return postTextDynamic(body, { dryRun })
}
