// src/bili.mjs — B 站内容读取（匿名可用）：推荐流、视频详情、标签、热评、热门
import { biliFetch, assertOk, jitter } from './http.mjs'
import { getWbiKeys, signWbi } from './wbi.mjs'

/** 补 buvid cookie（匿名请求也需要，否则风控概率高） */
export async function ensureBuvid(jar) {
  if (jar.get('buvid3')) return jar
  const data = await biliFetch('https://api.bilibili.com/x/frontend/finger/spi', { jar })
  if (data && data.code === 0 && data.data) {
    jar.set('buvid3', data.data.b_3)
    jar.set('buvid4', data.data.b_4)
  }
  return jar
}

/** 首页推荐流（匿名也可用；登录后是个性化） */
export async function rcmdFeed(jar, { ps = 12, pn = 1, freshType = 4 } = {}) {
  await ensureBuvid(jar)
  const { mixin } = await getWbiKeys(jar)
  const params = {
    web_location: '1430650',
    ps: String(ps),
    pn: String(pn),
    fresh_type: String(freshType),
    fresh_idx_1h: String(pn),
    fresh_idx: String(pn),
    brush: String(pn - 1),
    fetch_row: '1',
    homepage_ver: '1',
    y_num: '4',
    fresh_type_v2: '1',
    last_y_num: '5',
  }
  const url = `https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?${signWbi(params, mixin)}`
  const data = assertOk(await biliFetch(url, { jar, referer: 'https://www.bilibili.com/' }), '获取推荐流')
  const items = (data && data.item) || []
  return {
    items: items
      .filter((it) => it && it.goto === 'av' && it.bvid)
      .map((it) => ({
        bvid: it.bvid,
        aid: Number(it.id) || 0,
        cid: Number(it.cid) || 0,
        title: it.title || '',
        owner: (it.owner && it.owner.name) || '',
        ownerMid: Number(it.owner && it.owner.mid) || 0,
        duration: Number(it.duration) || 0,
        pubdate: Number(it.pubdate) || 0,
        desc: '',
        tags: [],
        comments: [],
        cover: normalizePic(it.pic),
        url: `https://www.bilibili.com/video/${it.bvid}`,
        stat: {
          view: Number(it.stat && it.stat.view) || 0,
          like: Number(it.stat && it.stat.like) || 0,
          danmaku: Number(it.stat && it.stat.danmaku) || 0,
          reply: Number(it.stat && it.stat.reply) || 0,
        },
        rcmdReason: (it.rcmd_reason && it.rcmd_reason.content) || '',
      })),
  }
}

function normalizePic(url) {
  const u = String(url || '')
  if (!u) return ''
  if (u.startsWith('//')) return 'https:' + u
  return u.replace(/^http:\/\//, 'https://')
}

function normalizeDesc(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

/** 视频详情（含标签、分P cid） */
export async function videoDetail(jar, bvid) {
  await ensureBuvid(jar)
  const view = assertOk(
    await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`, { jar }),
    '获取视频详情',
  )
  let tags = []
  try {
    const detail = await biliFetch(
      `https://api.bilibili.com/x/web-interface/view/detail?bvid=${encodeURIComponent(bvid)}`,
      { jar },
    )
    if (detail && detail.code === 0 && detail.data && Array.isArray(detail.data.Tags)) {
      tags = detail.data.Tags.map((t) => t.tag_name).filter(Boolean).slice(0, 10)
    }
  } catch {
    /* 标签失败不影响主流程 */
  }
  return {
    bvid,
    aid: Number(view.aid) || 0,
    cid: Number(view.cid) || 0,
    title: view.title || '',
    owner: (view.owner && view.owner.name) || '',
    ownerMid: Number(view.owner && view.owner.mid) || 0,
    duration: Number(view.duration) || 0,
    pubdate: Number(view.pubdate) || 0,
    desc: normalizeDesc(view.desc),
    tags,
    cover: normalizePic(view.pic),
    url: `https://www.bilibili.com/video/${bvid}`,
    stat: {
      view: Number(view.stat && view.stat.view) || 0,
      like: Number(view.stat && view.stat.like) || 0,
      danmaku: Number(view.stat && view.stat.danmaku) || 0,
      reply: Number(view.stat && view.stat.reply) || 0,
    },
  }
}

/** 热评（WBI 签名，匿名可用） */
export async function topComments(jar, { aid, ps = 8 } = {}) {
  await ensureBuvid(jar)
  const { mixin } = await getWbiKeys(jar)
  const params = {
    oid: String(aid),
    type: '1',
    mode: '3',
    pagination_str: '{"offset":""}',
    plat: '1',
    web_location: '1315875',
  }
  const url = `https://api.bilibili.com/x/v2/reply/wbi/main?${signWbi(params, mixin)}`
  const data = await biliFetch(url, { jar })
  if (!data || data.code !== 0) return []
  const replies = (data.data && data.data.replies) || []
  return replies
    .filter((r) => r && r.content && typeof r.content.message === 'string' && r.content.message.trim())
    .slice(0, ps)
    .map((r) => ({
      user: (r.member && r.member.uname) || '匿名',
      text: String(r.content.message || '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\n+/g, ' ')
        .trim()
        .slice(0, 120),
      like: Number(r.like) || 0,
    }))
}

/** 热门榜（与推荐流二选一，用作兜底/去重） */
export async function popular(jar, { ps = 20, pn = 1 } = {}) {
  await ensureBuvid(jar)
  const data = assertOk(
    await biliFetch(`https://api.bilibili.com/x/web-interface/popular?ps=${ps}&pn=${pn}`, {
      jar,
      referer: 'https://www.bilibili.com/v/popular/all',
    }),
    '获取热门榜',
  )
  const list = (data && data.list) || []
  return list.map((it) => ({
    bvid: it.bvid,
    aid: Number(it.aid) || 0,
    cid: Number(it.cid) || 0,
    title: it.title || '',
    owner: (it.owner && it.owner.name) || '',
    ownerMid: Number(it.owner && it.owner.mid) || 0,
    duration: Number(it.duration) || 0,
    pubdate: Number(it.pubdate) || 0,
    desc: normalizeDesc(it.desc),
    tags: [],
    comments: [],
    cover: normalizePic(it.pic),
    url: `https://www.bilibili.com/video/${it.bvid}`,
    stat: {
      view: Number(it.stat && it.stat.view) || 0,
      like: Number(it.stat && it.stat.like) || 0,
      danmaku: Number(it.stat && it.stat.danmaku) || 0,
      reply: Number(it.stat && it.stat.reply) || 0,
    },
  }))
}

/** 把推荐流条目补全成完整 Candidate（详情 + 热评） */
export async function enrichCandidate(jar, partial, { withComments = true } = {}) {
  const detail = await videoDetail(jar, partial.bvid)
  const merged = { ...partial, ...detail, bvid: partial.bvid }
  if (withComments && merged.aid) {
    await jitter()
    merged.comments = await topComments(jar, { aid: merged.aid })
  }
  return merged
}

// 兼容别名，子智能体/CLI 可能用到
export { rcmdFeed as feed }
