// src/actions.mjs — 她自己的生活动作：点赞 / 收藏 / 投币 / 关注 / 取关 / 追番
//
// 只做动作，不管“该不该做”（心情由 life/mood 决定，技术上限由 life.canAct 管）。
import { biliFetch, explainCode } from './http.mjs'
import { videoDetail } from './bili.mjs'
import {
  currentContext,
  likeVideo,
  favVideo,
  coinVideo,
  ensureFavFolder,
  followUser,
  relationAttribute,
} from './react.mjs'
import { getSelf } from './account.mjs'

const REFERER = 'https://www.bilibili.com/'
const ORIGIN = 'https://www.bilibili.com'

function context() {
  const ctx = currentContext()
  if (!ctx.csrf) throw new Error('缺少 bili_jct（csrf），请先 login')
  return ctx
}

async function aidOf(bvid, jar) {
  const video = await videoDetail(jar, bvid)
  if (!video || !video.aid) throw new Error(`拿不到 ${bvid} 的 aid`)
  return { aid: Number(video.aid), video }
}

export async function likeByBvid(bvid) {
  const { jar, csrf } = context()
  const { aid } = await aidOf(bvid, jar)
  const result = await likeVideo(jar, csrf, aid)
  return { ...result, bvid, aid, action: 'like' }
}

export async function favByBvid(bvid, { folderName = '海底', isPublic = true } = {}) {
  const { jar, csrf, mid } = context()
  const { aid } = await aidOf(bvid, jar)
  const folder = await ensureFavFolder(jar, csrf, mid, String(folderName || '海底'), isPublic ? 0 : 1)
  const result = await favVideo(jar, csrf, { aid, folderId: folder.id })
  return { ...result, bvid, aid, folder, action: 'fav' }
}

export async function coinByBvid(bvid) {
  const { jar, csrf } = context()
  const { aid } = await aidOf(bvid, jar)
  const result = await coinVideo(jar, csrf, aid, { multiply: 1, selectLike: 1 })
  return { ...result, bvid, aid, action: 'coin' }
}

export async function followMid(mid) {
  const { jar, csrf } = context()
  const attribute = await relationAttribute(jar, Number(mid))
  if (attribute === 2 || attribute === 6) return { ok: true, already: true, mid: Number(mid), action: 'follow' }
  const result = await followUser(jar, csrf, Number(mid))
  return { ...result, mid: Number(mid), action: 'follow' }
}

export async function unfollowMid(mid) {
  const { jar, csrf } = context()
  const attribute = await relationAttribute(jar, Number(mid))
  if (attribute !== 2 && attribute !== 6) return { ok: true, already: true, mid: Number(mid), action: 'unfollow' }
  const data = await biliFetch('https://api.bilibili.com/x/relation/modify', {
    jar,
    form: { fid: Number(mid), act: 2, re_src: 11, csrf },
    referer: REFERER,
    origin: ORIGIN,
  })
  const code = Number(data && data.code)
  return { ok: code === 0, code, message: (data && data.message) || explainCode(code), mid: Number(mid), action: 'unfollow' }
}

/** 追番（B 站“追番/追剧”接口，可能需要实测） */
export async function followBangumi(seasonId) {
  const { jar, csrf } = context()
  const data = await biliFetch('https://api.bilibili.com/x/space/bangumi/follow', {
    jar,
    form: { season_id: Number(seasonId), status: 1, csrf },
    referer: `https://www.bilibili.com/bangumi/play/ss${Number(seasonId)}`,
    origin: ORIGIN,
  })
  const code = Number(data && data.code)
  return { ok: code === 0, code, message: (data && data.message) || explainCode(code), seasonId: Number(seasonId), action: 'bangumi' }
}

/**
 * 给视频发一条**新评论**（只发自己的评论，不回复别人、不 @ 人）。
 * B 站评论接口需要 csrf（bili_jct）+ 登录态；频率/内容会被风控。
 */
export async function commentByBvid(bvid, text, { dryRun = false } = {}) {
  const { jar, csrf } = context()
  const message = String(text || '').trim()
  if (!message) throw new Error('评论内容不能为空')
  if (message.length > 1000) throw new Error('评论太长（B 站单条上限 1000 字）')
  const { aid } = await aidOf(bvid, jar)
  if (dryRun) return { ok: true, dryRun: true, bvid, aid, action: 'comment' }

  const data = await biliFetch('https://api.bilibili.com/x/v2/reply/add', {
    jar,
    form: { oid: aid, type: 1, message, plat: 1, csrf },
    referer: `https://www.bilibili.com/video/${bvid}`,
    origin: ORIGIN,
  })
  const code = Number(data && data.code)
  const rpid = data && data.data && (data.data.rpid_str || data.data.rpid)
  return {
    ok: code === 0,
    code,
    message: (data && data.message) || explainCode(code),
    bvid,
    aid,
    rpid: rpid ? String(rpid) : '',
    action: 'comment',
  }
}

export async function coinBalance() {
  const self = await getSelf()
  return self.coins
}
