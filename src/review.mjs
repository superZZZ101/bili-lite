// src/review.mjs — 「点评」提示词构建 + 私信文本分条
//
// 三个东西：
//   1. loadReviewPrompt(cfg)      —— 点评提示词可从文件/内联配置覆盖（用户可改）
//   2. buildReviewPrompt(video)   —— 给 DSH agent 用的「写一段点评」提示词（默认上限 480 字）
//   3. formatDmMessages(picks)    —— 把 pick + 点评拼成 ≤460 字的多条私信（长点评自动拆条）
// 点评不是一句话推荐，是具体看法；只能依据已有材料，拿不到字幕要说明。
import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_REVIEW_PROMPT = `你是一个替用户筛视频的编辑。写点评时：
- 口语、具体、直接，不吹捧，不用「神作/必看/震撼」这类词；
- 说清楚：它讲了什么、值不值得看、适合谁/什么场景看、有什么保留；
- 只能依据给定材料（标题/简介/标签/热评/弹幕/字幕），材料不足就明说「依据有限」，绝不编造内容；
- 唯一长度要求：不超过 480 字；有话则长、无话则短，不要为凑字数灌水。`

/** 点评默认上限（字） */
export const REVIEW_MAX_CHARS = 480

/** 读取点评/回复提示词：用户配置 > 内联 > 随包的 prompts/review.md > 内置默认 */
export function loadReviewPrompt(cfg = {}) {
  if (cfg.reviewPromptPath) {
    try {
      const abs = path.resolve(cfg.reviewPromptPath)
      const text = fs.readFileSync(abs, 'utf8').trim()
      if (text) return { text, source: abs }
    } catch {
      /* 文件读不到就继续向下回退 */
    }
  }
  if (cfg.reviewPromptText) return { text: String(cfg.reviewPromptText), source: 'inline' }
  // 随包自带的人设提示词：<skill>/prompts/review.md（私信回复风格以它为准）
  try {
    const bundled = path.join(import.meta.dirname, '..', 'prompts', 'review.md')
    const text = fs.readFileSync(bundled, 'utf8').trim()
    if (text) return { text, source: bundled }
  } catch {
    /* 随包文件缺失才用内置默认 */
  }
  return { text: DEFAULT_REVIEW_PROMPT, source: 'default' }
}

function plain(text, n = 400) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}

/** 把视频对象压缩成提示词用的材料（控制长度，避免把整包弹幕塞进去） */
export function summarizeVideo(video = {}) {
  const heat = video.danmakuHeat || (video.enrich && video.enrich.danmakuHeat)
  const subs = video.subtitles || (video.enrich && video.enrich.subtitles)
  const subtitleText = (subs && (subs.text || subs.plainText)) || ''
  return {
    bvid: video.bvid || '',
    title: video.title || '',
    up: video.owner || '',
    duration: video.duration ? `${Math.round(video.duration / 60)} 分钟` : '未知',
    desc: plain(video.desc, 300),
    tags: (video.tags || []).slice(0, 8),
    stats: video.stat
      ? { 播放: video.stat.view, 点赞: video.stat.like, 弹幕: video.stat.danmaku, 评论: video.stat.reply }
      : undefined,
    topComments: (video.comments || []).slice(0, 5).map((c) => `@${c.user}：${plain(c.text, 60)}`),
    danmakuHeat: heat && heat.summary ? heat.summary : undefined,
    subtitleSnippet: subtitleText ? plain(subtitleText, 800) : undefined,
    subtitleNote: subtitleText ? '有官方字幕摘录' : '无字幕，只能依据标题/简介/热评/弹幕',
  }
}

/**
 * 生成「给这条视频写点评」的提示词。
 * @param {object} video Candidate/视频详情
 * @param {{persona?:{text?:string}, reviewPrompt?:string, maxChars?:number}} opts
 */
export function buildReviewPrompt(
  video,
  { persona, reviewPrompt, maxChars = REVIEW_MAX_CHARS, extra = '' } = {},
) {
  const instruction = reviewPrompt || DEFAULT_REVIEW_PROMPT
  return `【任务】给下面这条 B 站视频写一段中文点评（不是一句话推荐，是具体看法）。

【点评要求】
${instruction}
- **点评也要用小女仆口吻**：开头一句叫「主人」/撒个娇，中间把内容讲清楚，结尾一句撒娇或小提醒；
  不要写成官方评测稿、不要通篇中性叙述（内容判断仍要真，别为了卖萌省掉「值不值得看」）。
- 总长不超过 ${maxChars} 字。

【用户人设】
${(persona && persona.text) || '说话直接、不吹捧，只说值不值得占用一次注意力。'}

【视频材料】
${JSON.stringify(summarizeVideo(video), null, 2)}

${extra ? `${extra}\n\n` : ''}【输出】只输出点评正文，不要标题、不要 Markdown、不要引号。`
}

/**
 * 生成「回复用户私信」的提示词（可能是纯聊天，也可能是分享了一个视频）。
 * 长度上限按 B 站私信上限来：B 站单条私信硬上限 500 字符，这里用 480 留余量
 * （dm.mjs 的 clampDmText 也会截到 480，防止触发 21007）。
 * @param {{text?:string, ts?:number, video?:object}} msg
 */
export function buildReplyPrompt(msg = {}, { persona, reviewPrompt, maxChars = 480 } = {}) {
  const instruction = reviewPrompt || DEFAULT_REVIEW_PROMPT
  const video = msg.video
  return `【任务】用户通过 B 站私信跟你说了一句话${video ? '，并分享了一条视频' : ''}。用中文回一条私信。

【风格 · 必须严格照这里来（来自 prompts/review.md）】
${instruction}

【硬性要求】
- 这是私信回复：≤${maxChars} 字是硬顶，不是目标长度。在意思完整的前提下尽可能短：
  能一句说完就一句，一般 1~3 句 / 20~80 字，不要为撒娇硬凑长度。
- 称呼、语气词、撒娇方式、结尾的小要求，全部按上面的「风格」来；不要写成朋友闲聊或客服口吻。
- 如果分享了视频：先给出你对这条视频的具体看法（值不值得看、依据是什么），再撒娇，不要复述标题。
- 材料不足就直说「没看到字幕/只看了标题和评论」，绝不编造。
- 不要提「AI/模型/提示词/系统」这些词；不要出现成人内容或过度性暗示。

【用户人设】
${(persona && persona.text) || '说话直接、不吹捧。'}

【用户消息】
${plain(msg.text, 200) || '（对方只分享了一个视频，没有文字）'}

${video ? `【分享的视频材料】\n${JSON.stringify(summarizeVideo(video), null, 2)}` : ''}

【输出】只输出要发出去的私信正文，不要解释、不要引号。`
}

/** 按长度切分文本，尽量在换行处断开 */
export function splitText(text, limit = 460) {
  const source = String(text || '')
  if (source.length <= limit) return [source]
  const chunks = []
  let rest = source
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit * 0.5) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/**
 * 把 picks 拼成私信文本（可多条）。
 *
 * 排版原则：**不套模板**——没有「一句话：」「点评：」标签、没有编号，
 * 让点评正文（按 prompts/review.md 自由发挥写）直接成段，标题和链接只做分隔。
 * 只保证：每行 ≤ 单条上限、单条消息 ≤ limit（默认 460，B 站硬上限 500）。
 *
 * @param {Array<{title:string, oneLiner?:string, review?:string, url?:string, bvid?:string}>} picks
 * @param {number} scannedCount
 * @param {{dmReview?:boolean, limit?:number}} opts
 * @returns {string[]} 每条 ≤ limit 的私信正文
 */
export function formatDmMessages(picks, scannedCount, { dmReview = true, limit = 460 } = {}) {
  if (!picks || !picks.length) return []
  const header = `主人～人家今天刷了 ${scannedCount} 条，挑了 ${picks.length} 条给你：`
  const footer = '主人看完记得摸摸头夸夸人家嘛～'
  const lines = [header]

  picks.forEach((p, i) => {
    lines.push(`《${plain(p.title, 40)}》`)
    // 有点评就自由成段（不贴标签）；没有点评才退回一句话，避免空消息
    const body = dmReview && p.review ? p.review : p.oneLiner || ''
    if (body) {
      const chunkSize = Math.max(120, limit - 100)
      const text = String(body).replace(/\s+/g, ' ').trim().slice(0, REVIEW_MAX_CHARS)
      splitText(text, chunkSize).forEach((chunk) => lines.push(chunk))
    }
    lines.push(`${p.url || `https://www.bilibili.com/video/${p.bvid}`}`)
    if (i < picks.length - 1) lines.push('')
  })
  lines.push(footer)

  const messages = []
  let current = ''
  for (const line of lines) {
    const safeLine = line.length > limit ? splitText(line, limit)[0] : line
    if (!current) {
      current = safeLine
    } else if (current.length + 1 + safeLine.length <= limit) {
      current += `\n${safeLine}`
    } else {
      messages.push(current)
      current = safeLine
    }
  }
  if (current) messages.push(current)
  return messages
}
