// src/account.mjs — B 站账号资料：改昵称 / 换头像（需要登录态）
//
// 实测结论（2026-10）：
// - 改昵称：POST /x/member/web/update（form: uname + csrf），需要 6 个硬币，不足返回 40007。
// - 换头像：POST /x/member/web/face/update?csrf=… ，**直接 multipart 上传文件，字段名 face**。
//   （旧文档里的「先传 OSS 再传 URL」流程已失效，/x/oss/web/photo/upload 返回 404；
//     直接传文件字段 face 成功，返回 code=0，data 是旧头像 URL。）
//   - 40012 头像格式错误（用 jpg/png，尺寸/大小合规）
//   - -702 请求频率过高
import fs from 'node:fs'
import path from 'node:path'
import { biliFetch, DEFAULT_HEADERS } from './http.mjs'
import { loadState } from './state.mjs'
import { cookiesToJar, checkLogin } from './auth.mjs'

function currentCsrf() {
  const state = loadState()
  const jar = cookiesToJar(state.cookies)
  const csrf =
    (state.cookies && (state.cookies.biliJct || state.cookies.raw?.bili_jct)) || jar.get('bili_jct')
  if (!csrf) throw new Error('缺少 bili_jct（csrf），请先 login')
  return { jar, csrf }
}

/** 当前账号资料（昵称、头像、等级、硬币） */
export async function getSelf() {
  const { jar } = currentCsrf()
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/nav', {
    jar,
    referer: 'https://space.bilibili.com/',
  })
  const d = (data && data.data) || {}
  return {
    loggedIn: !!d.isLogin,
    uname: d.uname || '',
    mid: Number(d.mid) || 0,
    face: d.face || '',
    level: d.level_info ? d.level_info.current_level : null,
    coins: typeof d.money === 'number' ? d.money : null,
  }
}

/**
 * 修改昵称。
 * @returns {Promise<{ok:boolean, code:number, message:string, uname?:string, coins?:number}>}
 */
export async function setNickname(uname) {
  const name = String(uname || '').trim()
  if (name.length < 2 || name.length > 20) {
    return { ok: false, code: -1, message: '昵称长度需在 2~20 个字符之间' }
  }
  const { jar, csrf } = currentCsrf()
  const data = await biliFetch('https://api.bilibili.com/x/member/web/update', {
    jar,
    form: { uname: name, csrf },
    referer: 'https://account.bilibili.com/account/face',
    origin: 'https://account.bilibili.com',
  })
  const code = Number(data && data.code)
  let coins = null
  try {
    const self = await getSelf()
    coins = self.coins
  } catch {
    /* 余额回读失败不影响结果 */
  }
  const hint =
    code === 40007
      ? '（改昵称需要 6 个硬币，当前不足；每日登录可领 1 个，或充值/等活动）'
      : code === -702
        ? '（请求频率过高，过几分钟再试）'
        : ''
  return { ok: code === 0, code, message: (data && data.message ? data.message : '') + hint, uname: code === 0 ? name : undefined, coins }
}

/**
 * 换头像：直接 multipart 上传文件到 face/update。
 * @param {string} filePath 本地图片（jpg/png，建议方形、≤2MB）
 */
export async function changeAvatar(filePath) {
  const abs = path.resolve(filePath)
  if (!fs.existsSync(abs)) return { ok: false, code: -1, message: `文件不存在：${abs}`, stage: 'read' }
  const login = await checkLogin(loadState().cookies || {})
  if (!login || !login.isLogin) return { ok: false, code: -101, message: '登录态无效，请先 login', stage: 'auth' }

  const { jar, csrf } = currentCsrf()
  const buffer = fs.readFileSync(abs)
  const ext = path.extname(abs).toLowerCase()
  const type =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
  const form = new FormData()
  form.append('face', new Blob([buffer], { type }), path.basename(abs))

  let response
  try {
    response = await fetch(
      `https://api.bilibili.com/x/member/web/face/update?csrf=${encodeURIComponent(csrf)}`,
      {
        method: 'POST',
        headers: {
          'User-Agent': DEFAULT_HEADERS['User-Agent'],
          Referer: 'https://account.bilibili.com/account/face',
          Origin: 'https://account.bilibili.com',
          Cookie: jar.header(),
        },
        body: form,
        signal: AbortSignal.timeout(45000),
      },
    )
  } catch (error) {
    return { ok: false, code: -1, message: `上传失败：${error.message}`, stage: 'upload' }
  }

  let data = {}
  try {
    data = await response.json()
  } catch {
    return { ok: false, code: -1, message: `响应非 JSON（HTTP ${response.status}）`, stage: 'upload' }
  }
  const code = Number(data && data.code)
  const hint =
    code === 40012
      ? '（头像格式错误：用 jpg/png，尺寸别太大）'
      : code === -702
        ? '（请求频率过高，过几分钟再试）'
        : ''
  if (code !== 0) {
    return {
      ok: false,
      code,
      message: `${data.message || ''}${hint}`,
      stage: 'update',
    }
  }

  // 成功后回读新头像地址（B 站会异步压缩/审核，立刻回读一般就能看到新 URL）
  let face = null
  try {
    const self = await getSelf()
    face = self.face || null
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    code,
    message: data.message || 'OK',
    face,
    previousFace: data.data || null,
    stage: 'done',
  }
}
