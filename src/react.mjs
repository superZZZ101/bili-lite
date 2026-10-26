// src/react.mjs — 账号互动：点赞 / 私密收藏 / 关注 UP（投币预留，默认关）
//
// 只对「当天 pick 的视频」执行，且每个动作都有开关（config.autoLike 等）。
// 全部走 B 站 web 接口 + csrf（bili_jct）：
//   点赞   POST /x/web-interface/archive/like        form: aid, like=1, csrf
//   投币   POST /x/web-interface/coin/add            form: aid, multiply=1, select_like, csrf
//   收藏   POST /x/v3/fav/resource/deal              form: rid=aid, type=2, add_media_ids=<folderId>, csrf
//   收藏夹 GET  /x/v3/fav/folder/created/list-all    ?up_mid=<mid>
//          POST /x/v3/fav/folder/add                 form: title, intro, privacy, csrf
//   关注   GET  /x/relation?fid=<mid>                → data.attribute（0 未关注 / 2 已关注 / 6 互关）
//          POST /x/relation/modify                   form: fid, act=1, re_src=11, csrf
// 说明：B 站收藏夹可以设为私密（privacy=1），收藏私密夹不会出现在公开动态里。
import { biliFetch, jitter, explainCode } from './http.mjs'
import { loadState } from './state.mjs'
import { cookiesToJar } from './auth.mjs'

const REFERER = 'https://www.bilibili.com/'
const ORIGIN = 'https://www.bilibili.com'

/** 当前登录上下文（jar / csrf / mid） */
export function currentContext() {
  const state = loadState()
  const jar = cookiesToJar(state.cookies)
  const csrf =
    (state.cookies && (state.cookies.biliJct || state.cookies.raw?.bili_jct)) || jar.get('bili_jct')
  const mid = Number(
    (state.cookies && (state.cookies.dedeUserId || state.cookies.raw?.DedeUserID)) ||
      jar.get('DedeUserID') ||
      0,
  )
  return { state, jar, csrf, mid }
}

function assert(code, message, label) {
  if (Number(code) !== 0) {
    const hint = explainCode(code)
    throw new Error(`${label}失败：${message || ''}（code=${code}，${hint}）`)
  }
}

/** 点赞（like=1 点赞，2 取消） */
export async function likeVideo(jar, csrf, aid) {
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/archive/like', {
    jar,
    form: { aid, like: 1, csrf },
    referer: `${REFERER}video/av${aid}`,
    origin: ORIGIN,
  })
  return { ok: Number(data.code) === 0, code: Number(data.code), message: data.message || '' }
}

/** 投币（默认投 1 个，并顺带点赞） */
export async function coinVideo(jar, csrf, aid, { multiply = 1, selectLike = 1 } = {}) {
  const data = await biliFetch('https://api.bilibili.com/x/web-interface/coin/add', {
    jar,
    form: { aid, multiply, select_like: selectLike, csrf },
    referer: `${REFERER}video/av${aid}`,
    origin: ORIGIN,
  })
  return { ok: Number(data.code) === 0, code: Number(data.code), message: data.message || '' }
}

/** 列出当前用户创建的收藏夹 */
export async function listFavFolders(jar, mid) {
  const data = await biliFetch(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
    { jar, referer: REFERER },
  )
  if (Number(data.code) !== 0) return []
  const list = (data.data && data.data.list) || []
  return list.map((f) => ({
    id: Number(f.id),
    title: f.title,
    mediaCount: Number(f.media_count) || 0,
    // attr 是位掩码：bit0 = 1 表示私密收藏夹（文档：0 公开 / 1 私有）
    private: (Number(f.attr) & 1) === 1,
  }))
}

/** 找到或创建指定收藏夹（默认私密） */
export async function ensureFavFolder(jar, csrf, mid, title, privacy = 1) {
  const folders = await listFavFolders(jar, mid)
  const existing = folders.find((f) => f.title === title)
  if (existing) return { ...existing, created: false }
  const data = await biliFetch('https://api.bilibili.com/x/v3/fav/folder/add', {
    jar,
    form: { title, intro: 'bili-lite 自动收藏', privacy, csrf },
    referer: 'https://www.bilibili.com/',
    origin: ORIGIN,
  })
  if (Number(data.code) !== 0) {
    throw new Error(`创建收藏夹失败：${data.message || ''}（code=${data.code}，${explainCode(data.code)}）`)
  }
  const id = Number(data.data && data.data.id)
  return { id, title, mediaCount: 0, private: privacy === 1, created: true }
}

/** 把视频加入收藏夹（type=2 表示视频） */
export async function favVideo(jar, csrf, { aid, folderId }) {
  const data = await biliFetch('https://api.bilibili.com/x/v3/fav/resource/deal', {
    jar,
    form: { rid: aid, type: 2, add_media_ids: folderId, del_media_ids: '', csrf },
    referer: `${REFERER}video/av${aid}`,
    origin: ORIGIN,
  })
  return { ok: Number(data.code) === 0, code: Number(data.code), message: data.message || '' }
}

/** 查询与某用户的关系：0 未关注 / 2 已关注 / 6 互关 / 128 黑名单 */
export async function relationAttribute(jar, mid) {
  const data = await biliFetch(`https://api.bilibili.com/x/relation?fid=${mid}`, { jar, referer: REFERER })
  if (Number(data.code) !== 0) return null
  return Number(data.data && data.data.attribute)
}

/** 关注用户（act=1 关注，2 取关；re_src=11 视频详情页来源） */
export async function followUser(jar, csrf, mid) {
  const data = await biliFetch('https://api.bilibili.com/x/relation/modify', {
    jar,
    form: { fid: mid, act: 1, re_src: 11, csrf },
    referer: REFERER,
    origin: ORIGIN,
  })
  return { ok: Number(data.code) === 0, code: Number(data.code), message: data.message || '' }
}

/**
 * 对一批 pick 执行互动。只做 config 打开的动作，并把结果写回 state.reacted。
 * @param {Array<{bvid:string, aid?:number, ownerMid?:number, title?:string}>} picks
 * @param {{like?:boolean, fav?:boolean, follow?:boolean, coin?:boolean, folderName?:string}} options
 * @param {{dryRun?:boolean}} io
 */
export async function runReactions(picks, options, { dryRun = true } = {}) {
  const { state, jar, csrf, mid } = currentContext()
  if (!csrf) throw new Error('缺少 bili_jct（csrf），请先 login')

  // 需要的候选里补 aid/ownerMid（picks 只存了摘要时用 candidates.json 补）
  const fs = await import('node:fs')
  const path = await import('node:path')
  let candidates = []
  try {
    candidates = JSON.parse(
      fs.readFileSync(path.join((await import('./state.mjs')).STATE_DIR, 'candidates.json'), 'utf8'),
    )
  } catch {
    /* 没有候选文件就只用 picks 自带字段 */
  }

  const results = []
  const folderName = options.folderName || 'bili-lite'
  let folder = null
  if (options.fav && !dryRun) {
    folder = await ensureFavFolder(jar, csrf, mid, folderName, 1)
  }

  for (const pick of picks) {
    const candidate = candidates.find((c) => c.bvid === pick.bvid) || {}
    const aid = Number(pick.aid || candidate.aid) || 0
    const ownerMid = Number(pick.ownerMid || candidate.ownerMid) || 0
    const record = { bvid: pick.bvid, title: pick.title || candidate.title || '', at: new Date().toISOString(), actions: {} }

    if (!aid) {
      results.push({ ...record, skipped: '缺少 aid（候选里查不到）' })
      continue
    }

    if (options.like) {
      if (dryRun) record.actions.like = 'dry-run'
      else {
        const r = await likeVideo(jar, csrf, aid)
        record.actions.like = r.ok ? 'ok' : `fail:${r.code}`
        await jitter(600, 1400)
      }
    }
    if (options.fav) {
      if (dryRun) record.actions.fav = `dry-run(${folderName})`
      else if (folder) {
        const r = await favVideo(jar, csrf, { aid, folderId: folder.id })
        record.actions.fav = r.ok ? 'ok' : `fail:${r.code}`
        await jitter(600, 1400)
      }
    }
    if (options.follow && ownerMid) {
      if (dryRun) record.actions.follow = 'dry-run'
      else {
        const attribute = await relationAttribute(jar, ownerMid)
        if (attribute === 0 || attribute === null) {
          const r = await followUser(jar, csrf, ownerMid)
          record.actions.follow = r.ok ? 'ok' : `fail:${r.code}`
        } else {
          record.actions.follow = 'already'
        }
        await jitter(600, 1400)
      }
    }
    if (options.coin) {
      if (dryRun) record.actions.coin = 'dry-run'
      else {
        const r = await coinVideo(jar, csrf, aid)
        record.actions.coin = r.ok ? 'ok' : `fail:${r.code}`
        await jitter(600, 1400)
      }
    }

    if (!dryRun) {
      state.reacted = state.reacted || {}
      state.reacted[pick.bvid] = { ...(state.reacted[pick.bvid] || {}), ...record.actions, at: record.at }
      const { saveState } = await import('./state.mjs')
      saveState(state)
    }
    results.push(record)
  }

  return { dryRun, folder, results }
}
