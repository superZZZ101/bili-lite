#!/usr/bin/env node
// src/cli.mjs — bili-lite 命令行入口（零依赖 ESM）
// 所有命令最后一行打印 `RESULT_JSON: {...}`，便于 DSH agent 解析。
import path from 'node:path'
import fs from 'node:fs'

import { CookieJar, sleep, jitter, explainCode } from './http.mjs'
import { rcmdFeed, popular, videoDetail, topComments, enrichCandidate } from './bili.mjs'
import { loadState, saveState, updateState, defaultConfig, ensureDirs, STATE_DIR, cfg } from './state.mjs'
import { checkLogin, qrLogin, getJar } from './auth.mjs'
import { sendDm, inboxNew, resolveB23, extractBvid } from './dm.mjs'
import { rankCandidates, autoPick, makePick, verdictFor } from './pick.mjs'
import { writeDigest } from './report.mjs'
import { loadPersona, buildOneLinerPrompt } from './persona.mjs'
import {
  beijingParts,
  fmtMinutes,
  getDayInfo,
  pickRandomSlot,
  isPeak,
  isPreferredTime,
  nonPeakMinute,
  nextAllowedMinute,
  describePlan,
  PEAK_TEXT,
  PREFERRED_TEXT,
} from './calendar.mjs'
import { getSelf, setNickname, changeAvatar } from './account.mjs'
import { runReactions } from './react.mjs'
import { loadReviewPrompt, buildReviewPrompt, buildReplyPrompt, formatDmMessages, splitText } from './review.mjs'
import { computeDecay, shouldShareToday, markInteraction } from './decay.mjs'
import * as diary from './diary.mjs'
import * as moodLib from './mood.mjs'
import * as impressionLib from './impressions.mjs'
import * as speechLib from './speech.mjs'
import * as commentsLib from './comments.mjs'
import * as memoryLib from './memory.mjs'
import * as lifeLib from './life.mjs'
import { postDynamic, deleteDynamic, checkDynamicPrivacy } from './dynamic.mjs'
import {
  extractFrames,
  cleanupFrames,
  latestFrameRunDir,
  runVisionForRun,
  visionStatusForRun,
  writeRunMeta,
} from './frames.mjs'
import {
  likeByBvid,
  favByBvid,
  coinByBvid,
  commentByBvid,
  followMid,
  unfollowMid,
  followBangumi,
  coinBalance,
} from './actions.mjs'
import {
  biliHome,
  buildMemoryPack,
  buildTurn,
  cliPath,
  inspectSession,
  loadSessions,
  markReset,
  resetCardText,
  sessionsFile,
} from './session.mjs'

const ROOT = path.join(import.meta.dirname, '..')
const CANDIDATES_JSON = path.join(STATE_DIR || path.join(ROOT, 'state'), 'candidates.json')

// ── 小工具 ──────────────────────────────────────────────────────────────────

function printResult(obj) {
  console.log(`RESULT_JSON: ${JSON.stringify(obj)}`)
}

function die(message, code = 1) {
  console.error(`错误：${message}`)
  printResult({ ok: false, error: message })
  process.exit(code)
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function fmtDuration(sec) {
  const s = Number(sec) || 0
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

function truncate(text, n) {
  const s = String(text || '')
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`
}

/** 并发受限的 map */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next
        i++
      } else {
        args[key] = true
      }
    } else {
      args._.push(token)
    }
  }
  return args
}

function ensureStateSkeleton() {
  ensureDirs()
  const state = loadState()
  state.config = { ...defaultConfig(), ...(state.config || {}) }
  return state
}

function markSeen(state, bvid, action) {
  state.seen = state.seen || {}
  state.seen[bvid] = { ...(state.seen[bvid] || {}), action, at: new Date().toISOString() }
}

function countSentToday(state) {
  const day = today()
  return Object.values(state.seen || {}).filter(
    (v) => v && v.action === 'sent' && String(v.at || '').startsWith(day),
  ).length
}

// ── login ──────────────────────────────────────────────────────────────────

async function cmdLogin(args) {
  const state = ensureStateSkeleton()
  if (state.cookies && !args.force) {
    const jar = await getJar()
    const info = await checkLogin(jar.toObject())
    if (info && info.isLogin) {
      console.log(`已登录：${info.uname}（uid=${info.uid}）`)
      printResult({ ok: true, alreadyLoggedIn: true, uid: info.uid, uname: info.uname })
      return
    }
    console.log('本地登录态已失效，重新扫码。')
  }
  console.log('正在生成登录二维码……')
  const { cookies, uid, qrPath } = await qrLogin({
    onQr: (info) => {
      const url = typeof info === 'string' ? info : info && info.url
      const gif = info && typeof info === 'object' ? info.qrPath : null
      console.log('\n手机 B 站 App 扫码登录：')
      console.log(`  二维码图片：${gif || path.join(STATE_DIR, 'qrcode.gif')}`)
      console.log(`  二维码内容：${url || '(见上方)'}`)
      console.log('')
    },
  })
  // qrLogin 内部已经把 cookies 写进 state；这里重读文件，避免用登录前的旧快照覆盖 targetUid 等字段
  const fresh = loadState()
  fresh.cookies = { ...(fresh.cookies || {}), ...cookies, savedAt: new Date().toISOString() }
  fresh.config = { ...defaultConfig(), ...(fresh.config || {}) }
  saveState(fresh)
  console.log(`\n登录成功，uid=${uid}。Cookie 已保存到 ${STATE_DIR}（不会打印内容）。`)
  printResult({ ok: true, uid, qrPath: qrPath || path.join(STATE_DIR, 'qrcode.gif') })
}

// ── scan ───────────────────────────────────────────────────────────────────

async function cmdScan(args) {
  const state = ensureStateSkeleton()
  const limit = Math.max(4, Math.min(30, Number(args.limit) || 20))
  const withEnrich = args.enrich !== 'false' && args.enrich !== false
  const jar = await getJar()
  console.log(`开始刷推荐流（目标 ${limit} 条）……`)

  let feed = { items: [] }
  try {
    feed = await rcmdFeed(jar, { ps: Math.min(limit, 30) })
  } catch (error) {
    console.log(`推荐流失败：${error.message}，改用热门榜兜底`)
  }
  let items = feed.items || []
  if (items.length < 4) {
    const hot = await popular(jar, { ps: Math.min(limit, 20) })
    items = items.concat(hot)
  }

  // 去重 + 过滤已看
  const seenIds = new Set(items.map((it) => it.bvid))
  items = items.filter((it) => seenIds.has(it.bvid))
  const fresh = items.filter((it) => !(state.seen && state.seen[it.bvid]))
  const pool = fresh.length ? fresh : items
  console.log(`推荐流 ${items.length} 条，其中新视频 ${fresh.length} 条。`)

  // 补详情（并发 3）
  const enriched = await mapLimit(pool.slice(0, limit), 3, async (item) => {
    try {
      return await enrichCandidate(jar, item, { withComments: true })
    } catch (error) {
      return { ...item, error: error.message }
    }
  })
  const good = enriched.filter((c) => !c.error)

  // 可选：字幕/弹幕（慢，只给前 8 条）
  if (withEnrich && good.length) {
    try {
      const { enrichVideo } = await import('./enrich.mjs')
      const top = good.slice(0, 8)
      await mapLimit(top, 2, async (candidate) => {
        try {
          await enrichVideo(jar, candidate, { withSubtitles: true, withDanmaku: true, withCover: true })
        } catch {
          /* 富化失败不影响主流程 */
        }
      })
    } catch (error) {
      console.log(`富化模块不可用，跳过字幕/弹幕：${error.message}`)
    }
  }

  const ranked = rankCandidates(good, state.config, state.seen || {})
  state.candidates = ranked
  state.lastScanAt = new Date().toISOString()
  saveState(state)
  fs.mkdirSync(path.dirname(CANDIDATES_JSON), { recursive: true })
  fs.writeFileSync(CANDIDATES_JSON, JSON.stringify(ranked, null, 2), 'utf8')

  console.log(`\n扫描完成：${ranked.length} 条候选已写入 ${CANDIDATES_JSON}`)
  for (const c of ranked.slice(0, 10)) {
    console.log(
      `- ${c.bvid} | ${truncate(c.title, 34)} | ${c.owner} | ${fmtDuration(c.duration)} | 分 ${c.score}`,
    )
  }
  printResult({
    ok: true,
    scanned: items.length,
    fresh: fresh.length,
    kept: ranked.length,
    candidatesPath: CANDIDATES_JSON,
    top: ranked.slice(0, 5).map((c) => ({ bvid: c.bvid, title: c.title, score: c.score })),
  })
}

// ── review ─────────────────────────────────────────────────────────────────

async function cmdReview() {
  const state = ensureStateSkeleton()
  const ranked = state.candidates || []
  if (!ranked.length) die('没有候选，先运行 scan')
  const persona = loadPersona(state.config)
  const taken = new Set((state.picks || []).map((p) => p.bvid))

  console.log(`候选 ${ranked.length} 条（人设来源：${persona.source}）：\n`)
  ranked.slice(0, 12).forEach((c, i) => {
    const flag = taken.has(c.bvid) ? '✓' : ' '
    console.log(`${flag} [${i + 1}] ${c.bvid}  分 ${c.score}  ${verdictFor(c.score)}`)
    console.log(`    ${truncate(c.title, 60)} | ${c.owner} | ${fmtDuration(c.duration)}`)
    if (c.desc) console.log(`    简介：${truncate(c.desc, 80)}`)
    if (c.reasons && c.reasons.length) console.log(`    理由：${c.reasons.join(' / ')}`)
    if (c.danmakuHeat && c.danmakuHeat.summary) console.log(`    弹幕：${c.danmakuHeat.summary}`)
    console.log('')
  })

  const prompt = buildOneLinerPrompt(ranked.slice(0, 12), persona)
  const promptPath = path.join(STATE_DIR, 'prompt-oneliner.md')
  fs.writeFileSync(promptPath, prompt, 'utf8')
  console.log(`给模型的一句话说提示词已写入：${promptPath}`)
  console.log(`（也可直接让 DSH agent 按该提示词产出 JSON，再逐条 pick）`)
  printResult({
    ok: true,
    count: ranked.length,
    promptPath,
    candidates: ranked.slice(0, 12).map((c) => ({
      bvid: c.bvid,
      title: c.title,
      score: c.score,
      verdictHint: verdictFor(c.score),
    })),
  })
}

// ── pick ───────────────────────────────────────────────────────────────────

async function cmdPick(args) {
  const state = ensureStateSkeleton()
  const bvid = args.bvid
  if (!bvid) die('缺少 --bvid')
  const verdict = args.verdict || '可以看'
  if (!['值得看', '可以看', '不值当'].includes(verdict)) die('--verdict 只能是 值得看/可以看/不值当')
  const oneLiner = truncate(args['one-liner'] || args.oneLiner || '', 60)
  if (!oneLiner) die('缺少 --one-liner "一句话"')
  const review = truncate(args.review || '', Number(state.config.reviewMaxChars) || 480)

  const candidate = (state.candidates || []).find((c) => c.bvid === bvid)
  if (!candidate) die(`候选里没有 ${bvid}，先 review 或 scan`)

  const pick = makePick(candidate, { verdict, oneLiner })
  // 只把摘要写进 state，避免把弹幕桶/评论全量重复存一遍（state.json 会膨胀）
  const compact = {
    bvid: pick.bvid,
    title: pick.title,
    owner: pick.owner,
    duration: pick.duration,
    url: pick.url,
    cover: pick.cover || '',
    score: pick.score,
    verdict: pick.verdict,
    oneLiner: pick.oneLiner,
    review: review || '',
    pickedAt: pick.pickedAt,
  }
  state.picks = (state.picks || []).filter((p) => p.bvid !== bvid)
  state.picks.push(compact)
  markSeen(state, bvid, verdict === '不值当' ? 'skipped' : 'picked')
  saveState(state)
  console.log(`已记录：${verdict}｜${truncate(candidate.title, 40)}｜${oneLiner}`)
  printResult({ ok: true, pick: compact })
}

// ── react（点赞 / 私密收藏 / 关注 / 投币）─────────────────────────────────

async function cmdReact(args) {
  const state = ensureStateSkeleton()
  const config = state.config
  const options = {
    like: Boolean(args.like) || config.autoLike === true,
    fav: Boolean(args.fav) || config.autoFav === true,
    follow: Boolean(args.follow) || config.autoFollow === true,
    coin: Boolean(args.coin) || config.autoCoin === true,
    folderName: config.favFolderName || 'bili-lite',
  }
  if (!options.like && !options.fav && !options.follow && !options.coin) {
    die(
      '没有开启任何互动：先 config autoLike=true / autoFav=true / autoFollow=true（投币 autoCoin=true，建议改名后再开）',
    )
  }
  const todayStr = today()
  let picks = (state.picks || []).filter((p) => String(p.pickedAt || '').startsWith(todayStr))
  if (args.bvid) picks = picks.filter((p) => p.bvid === args.bvid)
  if (!picks.length) die('今天还没有 pick 的视频，先 pick')
  const dryRun = !args.yes
  const actionNames = Object.entries(options)
    .filter(([, value]) => typeof value === 'boolean' && value)
    .map(([key]) => key)
    .join(' / ')
  console.log(`将对 ${picks.length} 条视频执行：${actionNames}${dryRun ? '（dry-run）' : ''}`)
  const result = await runReactions(picks, options, { dryRun })
  for (const item of result.results) {
    const acts = Object.entries(item.actions || {})
      .map(([k, v]) => `${k}:${v}`)
      .join(' ')
    console.log(`- ${item.bvid} ${truncate(item.title, 30)} ${acts || item.skipped || ''}`)
  }
  if (dryRun) console.log('dry-run：没有真的执行。加 --yes 才会点赞/收藏/关注。')
  printResult({
    ok: true,
    dryRun,
    options,
    folder: result.folder || null,
    results: result.results,
  })
}

// ── send ───────────────────────────────────────────────────────────────────

function formatDmText(picks, scannedCount) {
  const lines = [`今天刷了 ${scannedCount} 条，挑了 ${picks.length} 条：`]
  picks.forEach((p, i) => {
    lines.push(`${i + 1}. ${truncate(p.title, 40)}`)
    lines.push(`   ${p.oneLiner}`)
    lines.push(`   https://www.bilibili.com/video/${p.bvid}`)
  })
  if (lines.join('\n').length > 480) {
    // 私信 500 字硬上限，太长就只保留标题/一句话，去掉多余说明
    return truncate(
      picks
        .slice(0, 3)
        .map((p) => `· ${truncate(p.title, 28)}：${truncate(p.oneLiner, 26)}\nhttps://www.bilibili.com/video/${p.bvid}`)
        .join('\n'),
      480,
    )
  }
  return lines.join('\n')
}

async function cmdSend(args) {
  const state = ensureStateSkeleton()
  const config = state.config
  // 自由发挥模式：--text "整段私信" 或 --file state/outbox.txt，代码只负责按 460 字拆条
  const rawInput = args.file
    ? (() => {
        const file = path.resolve(String(args.file))
        if (!fs.existsSync(file)) die(`--file 指定的文件不存在：${file}`)
        return fs.readFileSync(file, 'utf8')
      })()
    : String(args.text || '')
  const rawText = rawInput.trim()
  const isRaw = Boolean(rawText)

  const pending = (state.picks || []).filter(
    (p) => p && p.verdict !== '不值当' && (state.seen[p.bvid] || {}).action !== 'sent',
  )
  if (!isRaw && !pending.length) die('没有待投递的 pick，先 pick（或使用 send --text / --file 直接给整段私信）')

  const quota = Number(config.dailyLimit ?? 2) - countSentToday(state)
  if (quota <= 0 && !args.force) {
    die(`今日额度已用完（dailyLimit=${config.dailyLimit}，今日已发 ${countSentToday(state)} 条）；要手动补发加 --force`)
  }
  const picks = pending.slice(0, isRaw || args.force ? pending.length : quota)
  let scannedCount = 0
  try {
    scannedCount = JSON.parse(fs.readFileSync(CANDIDATES_JSON, 'utf8')).length
  } catch {
    scannedCount = (state.candidates || []).length
  }
  const dmReview = config.dmReview !== false
  const messages = isRaw ? splitText(rawText, 460) : formatDmMessages(picks, scannedCount, { dmReview })
  const totalChars = messages.reduce((sum, m) => sum + m.length, 0)

  const dryRun = config.dryRun !== false
  console.log(`\n———— 待投递私信：${messages.length} 条 / 共 ${totalChars} 字 ————`)
  messages.forEach((m, i) => {
    console.log(`--- 第 ${i + 1}/${messages.length} 条（${m.length} 字）---`)
    console.log(m)
  })
  console.log('——————————————————————\n')
  if (dryRun) {
    console.log('dry-run：没有真的发送。确认后先 `config dryRun=false` 关闭 dry-run，再运行 `send --yes`。')
    const digest = await writeDigest(state, { date: today(), picks, scannedCount, mode: 'dry-run' })
    printResult({ ok: true, dryRun: true, messages, picks: picks.map((p) => p.bvid), ...digest })
    return
  }
  if (!args.yes) die('真发需要同时加 --yes')

  const jar = await getJar()
  const info = await checkLogin(jar.toObject())
  if (!info || !info.isLogin) die('登录态无效，先运行 login')

  const targetUid = Number(config.targetUid) || Number(info.uid)
  if (!targetUid) die('无法确定收件人 uid（config.targetUid 为空且登录态缺 uid）')
  console.log(`发送到 uid=${targetUid}，共 ${messages.length} 条 ……`)
  let sentMessages = 0
  for (const text of messages) {
    const result = await sendDm(jar.toObject(), { uid: targetUid, text })
    if (!result.ok) {
      const hint =
        String(result.code) === '21026' || /21026|不能给自己/.test(String(result.error || ''))
          ? '（B 站不允许给自己发私信：targetUid 必须是另一个账号，且与登录账号互关）'
          : ''
      die(`第 ${sentMessages + 1}/${messages.length} 条私信发送失败：${result.error || result.code}${hint}（已成功 ${sentMessages} 条，未标记为已发）`)
    }
    sentMessages++
    speechLib.logSpeech({
      channel: 'dm-owner',
      to: targetUid,
      text,
      proactive: false,
      mood: moodLib.loadMood().label,
    })
    await sleep(800 + Math.floor(Math.random() * 700))
  }

  picks.forEach((p) => markSeen(state, p.bvid, 'sent'))
  state.lastSendAt = new Date().toISOString()
  state.lastAutoRunAt = state.lastSendAt
  // 记录「上次推荐日」（北京时间日期），供互动衰减计算 everyNDays
  state.lastShareDay = beijingParts().dateStr
  saveState(state)
  const digest = await writeDigest(state, { date: today(), picks, scannedCount, mode: 'sent' })
  console.log(`已发送 ${picks.length} 条视频推荐（${messages.length} 条私信）。报告：${digest.mdPath}`)
  printResult({ ok: true, sent: picks.length, messages: messages.length, targetUid, texts: messages, ...digest })
}

// ── inbox / reply ──────────────────────────────────────────────────────────

async function cmdInbox(args) {
  const state = ensureStateSkeleton()
  const jar = await getJar()
  const info = await checkLogin(jar.toObject())
  if (!info || !info.isLogin) die('登录态无效，先运行 login')
  const ownerUid = Number(state.config.targetUid) || Number(info.uid)
  const sinceTs = Number(args.since) || Number(state.inboxAckTs) || 0
  const inbox = await inboxNew(jar.toObject(), { sinceTs, ownerUid })
  const messages = inbox.fromOwner || []

  for (const msg of messages) {
    console.log(`[${new Date(msg.ts * 1000).toLocaleString()}] ${truncate(msg.text, 200)}`)
    let bvid = msg.shareBvid || extractBvid(msg.text)
    if (!bvid) bvid = (await resolveB23(msg.text))?.bvid || null
    if (bvid) {
      try {
        const video = await videoDetail(jar, bvid)
        video.comments = await topComments(jar, { aid: video.aid, ps: 5 })
        try {
          const { enrichVideo } = await import('./enrich.mjs')
          await enrichVideo(jar, video, { withSubtitles: true, withDanmaku: true, withCover: false })
        } catch {
          /* 字幕/弹幕拿不到不影响回复 */
        }
        msg.video = video
        console.log(`  ↳ 分享视频：${truncate(video.title, 50)}（${video.owner}）`)
      } catch (error) {
        console.log(`  ↳ 视频解析失败：${error.message}`)
      }
    }
  }

  if (messages.length) {
    const noWrite = process.env.BILI_LITE_NO_WRITE === '1'
    if (noWrite) {
      console.log('（BILI_LITE_NO_WRITE：不更新已读、不落盘提示词，适合只读沙箱会话）')
    } else {
      state.inboxAckTs = Math.max(...messages.map((m) => Number(m.ts) || 0))
      saveState(state)
      const replyPrompt = path.join(STATE_DIR, 'prompt-reply.md')
      try {
        const persona = loadPersona(state.config)
        const reviewPrompt = loadReviewPrompt(state.config)
        const last = messages[messages.length - 1]
        fs.writeFileSync(
          replyPrompt,
          buildReplyPrompt(last, { persona, reviewPrompt: reviewPrompt.text }),
          'utf8',
        )
      } catch {
        /* 可选 */
      }
    }
    console.log(`\n共 ${messages.length} 条新私信（只回本人）。回复：reply --text "..."`)
    // 你在私信里说话了 = 互动：立刻解除 / 重置衰减
    const before = state.lastInteractionAt || null
    markInteraction(state, Math.max(...messages.map((m) => Number(m.ts) || 0)), 'dm')
    if (!noWrite) saveState(state)
    if (before !== state.lastInteractionAt) {
      console.log(`已记录互动（${state.lastInteractionAt}）：推荐节律恢复正常`)
    }
  } else {
    console.log('没有新私信。')
  }
  printResult({ ok: true, new: messages.length, messages, othersCount: inbox.othersCount || 0, lastInteractionAt: state.lastInteractionAt || null })
}

async function cmdReply(args) {
  const state = ensureStateSkeleton()
  const text = truncate(args.text || '', 480)
  if (!text) die('缺少 --text "回复内容"')
  if (args.proactive) {
    const cap = lifeLib.canAct('proactive')
    if (!cap.ok) die(cap.reason)
  }
  const jar = await getJar()
  const info = await checkLogin(jar.toObject())
  if (!info || !info.isLogin) die('登录态无效，先运行 login')
  const ownerUid = Number(state.config.targetUid) || Number(info.uid)
  // --to <uid>：回复陌生人；不传就回主人
  const targetUid = Number(args.to) || ownerUid
  const replyChannel = args.proactive ? 'proactive' : targetUid === ownerUid ? 'dm-owner' : 'dm-stranger'
  try {
    const check = speechLib.checkSpeech(text, { channel: replyChannel, to: targetUid })
    for (const warning of check.warnings) console.error(`⚠ ${warning}`)
  } catch {
    /* 检查失败不影响发送 */
  }
  const result = await sendDm(jar.toObject(), { uid: targetUid, text })
  if (!result.ok) die(`回复失败：${result.error || result.code}`)
  const channel = replyChannel
  speechLib.logSpeech({
    channel,
    to: targetUid,
    text,
    proactive: Boolean(args.proactive),
    mood: moodLib.loadMood().label,
    replyTo: args['reply-to'] || '',
  })
  if (args.proactive) lifeLib.noteAction('proactive')
  console.log(`已回复 uid=${targetUid}：${text}`)
  printResult({ ok: true, uid: targetUid, toOwner: targetUid === ownerUid, text, channel })
}

// ── account（改昵称 / 换头像）─────────────────────────────────────────────

async function cmdAccount() {
  const self = await getSelf()
  if (!self.loggedIn) die('未登录，先运行 login')
  console.log(`账号：${self.uname}（uid=${self.mid}）｜硬币 ${self.coins ?? '?'}｜等级 ${self.level ?? '?'}`)
  if (self.face) console.log(`头像：${self.face}`)
  printResult({ ok: true, ...self })
}

async function cmdRename(args) {
  const name = args.name || args._[0]
  if (!name) die('缺少 --name "新昵称"')
  const result = await setNickname(name)
  if (!result.ok) die(`改昵称失败（code=${result.code}）：${result.message}（当前硬币 ${result.coins ?? '?'}）`)
  console.log(`昵称已改为：${result.uname}`)
  printResult({ ok: true, ...result })
}

async function cmdAvatar(args) {
  const file = args.file || args._[0]
  if (!file) die('缺少 --file <图片路径>')
  const result = await changeAvatar(file)
  if (!result.ok) die(`换头像失败（code=${result.code}，阶段 ${result.stage || '?'}）：${result.message}`)
  console.log(`头像已更新：${result.url}`)
  printResult({ ok: true, ...result })
}

// ── config ─────────────────────────────────────────────────────────────────

const CONFIG_SPEC = {
  dryRun: { type: 'bool' },
  targetUid: { type: 'int' },
  dailyLimit: { type: 'int', min: 0, max: 10 },
  minDuration: { type: 'int', min: 0 },
  maxDuration: { type: 'int', min: 0 },
  personaText: { type: 'str' },
  personaPath: { type: 'str' },
  preferKeywords: { type: 'list' },
  autoSend: { type: 'bool' },
  scheduleSkipChance: { type: 'float', min: 0, max: 1 },
  autoLike: { type: 'bool' },
  autoFav: { type: 'bool' },
  autoFollow: { type: 'bool' },
  autoCoin: { type: 'bool' },
  favFolderName: { type: 'str' },
  dmReview: { type: 'bool' },
  reviewPromptPath: { type: 'str' },
  reviewPromptText: { type: 'str' },
  diaryPromptPath: { type: 'str' },
  reviewMaxChars: { type: 'int', min: 120, max: 480 },
  watchInterval: { type: 'int', min: 15, max: 600 },
  replyStrangers: { type: 'bool' },
  sessionResetRounds: { type: 'int', min: 0, max: 100 },
  sessionResetChars: { type: 'int', min: 0, max: 2000000 },
  diaryPackChars: { type: 'int', min: 500, max: 20000 },
  lifeEnabled: { type: 'bool' },
  lifeScanLimit: { type: 'int', min: 1, max: 20 },
  dynamicDailyCap: { type: 'int', min: 0, max: 10 },
  proactiveDailyCap: { type: 'int', min: 0, max: 50 },
  memoryKeepRatio: { type: 'float', min: 0.1, max: 0.9 },
  autoRecommendations: { type: 'bool' },
}

function coerceConfigValue(key, raw) {
  const spec = CONFIG_SPEC[key]
  if (!spec) return { error: `未知配置项 ${key}（可用：${Object.keys(CONFIG_SPEC).join(' / ')}）` }
  if (spec.type === 'bool') {
    if (/^(true|1|yes|on)$/i.test(raw)) return { value: true }
    if (/^(false|0|no|off)$/i.test(raw)) return { value: false }
    return { error: `${key} 需要 true/false` }
  }
  if (spec.type === 'int') {
    const num = Number(raw)
    if (!Number.isFinite(num)) return { error: `${key} 需要数字` }
    if (spec.min !== undefined && num < spec.min) return { error: `${key} 不能小于 ${spec.min}` }
    if (spec.max !== undefined && num > spec.max) return { error: `${key} 不能大于 ${spec.max}` }
    return { value: Math.round(num) }
  }
  if (spec.type === 'float') {
    const num = Number(raw)
    if (!Number.isFinite(num)) return { error: `${key} 需要数字` }
    if (spec.min !== undefined && num < spec.min) return { error: `${key} 不能小于 ${spec.min}` }
    if (spec.max !== undefined && num > spec.max) return { error: `${key} 不能大于 ${spec.max}` }
    return { value: num }
  }
  if (spec.type === 'list') {
    return { value: String(raw).split(/[,，\s]+/).filter(Boolean) }
  }
  return { value: String(raw) }
}

function configSummary(config) {
  return {
    dryRun: config.dryRun !== false,
    targetUid: Number(config.targetUid) || 0,
    dailyLimit: Number(config.dailyLimit ?? 2),
    minDuration: Number(config.minDuration ?? 180),
    maxDuration: Number(config.maxDuration ?? 1800),
    personaPath: config.personaPath || '',
    personaText: truncate(config.personaText || '', 60),
    preferKeywords: config.preferKeywords || [],
    autoSend: config.autoSend === true,
    scheduleSkipChance: Number(config.scheduleSkipChance ?? 0),
    autoLike: config.autoLike === true,
    autoFav: config.autoFav === true,
    autoFollow: config.autoFollow === true,
    autoCoin: config.autoCoin === true,
    favFolderName: config.favFolderName || 'bili-lite',
    dmReview: config.dmReview !== false,
    reviewPromptPath: config.reviewPromptPath || '',
    reviewPromptText: truncate(config.reviewPromptText || '', 60),
    diaryPromptPath: config.diaryPromptPath || '',
    watchInterval: Number(config.watchInterval ?? 60),
    replyStrangers: config.replyStrangers !== false,
    reviewMaxChars: Number(config.reviewMaxChars ?? 480),
    sessionResetRounds: Number(config.sessionResetRounds ?? 0),
    sessionResetChars: Number(config.sessionResetChars ?? 0),
    diaryPackChars: Number(config.diaryPackChars ?? 2600),
    lifeEnabled: config.lifeEnabled !== false,
    lifeScanLimit: Number(config.lifeScanLimit ?? 8),
    dynamicDailyCap: Number(config.dynamicDailyCap ?? 3),
    proactiveDailyCap: Number(config.proactiveDailyCap ?? 10),
    memoryKeepRatio: Number(config.memoryKeepRatio ?? 0.63),
    autoRecommendations: config.autoRecommendations === true,
  }
}

async function cmdConfig(args) {
  const state = ensureStateSkeleton()
  const pairs = args._.filter((t) => t.includes('='))
  if (!pairs.length) {
    const summary = configSummary(state.config)
    console.log('当前配置：')
    for (const [k, v] of Object.entries(summary)) console.log(`  ${k} = ${JSON.stringify(v)}`)
    console.log('\n修改：node src/cli.mjs config dryRun=false dailyLimit=3')
    printResult({ ok: true, config: summary })
    return
  }
  const changed = {}
  for (const pair of pairs) {
    const idx = pair.indexOf('=')
    const key = pair.slice(0, idx)
    const raw = pair.slice(idx + 1)
    const result = coerceConfigValue(key, raw)
    if (result.error) die(result.error)
    state.config[key] = result.value
    changed[key] = result.value
  }
  saveState(state)
  console.log('已更新：', JSON.stringify(changed))
  printResult({ ok: true, changed, config: configSummary(state.config) })
}

// ── plan / guard（避开 DeepSeek 高峰）──────────────────────────────────────

function clamp01(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return 0
  return Math.max(0, Math.min(1, num))
}

/** 互动衰减状态（供 plan / guard / 定时任务判断今天该不该推荐） */
function decayInfo(state) {
  const decay = computeDecay(state)
  const todayStr = beijingParts().dateStr
  const decision = shouldShareToday(decay, state.lastShareDay || null, todayStr)
  return { decay, decision, today: todayStr }
}

/** dateStr 平移 n 天（YYYY-MM-DD） */
function shiftDate(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  const pad = (n) => String(n).padStart(2, '0')
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/**
 * 最近一次可用的非高峰时段：今天还有就取最近的，没有（例如已过 24:00 前的最后一格）就顺延到第二天 00:00。
 * 2026-10-23 已解除 06:00–22:00 限制，允许时段覆盖全天，所以顺延点是次日 00:00。
 */
function nextAvailableSlot(now, dayInfo) {
  const todayMinute = nextAllowedMinute(dayInfo, now.minutes)
  if (todayMinute != null) {
    return { minutes: todayMinute, at: `${now.dateStr}T${fmtMinutes(todayMinute)}:00+08:00`, dayOffset: 0 }
  }
  const tomorrow = shiftDate(now.dateStr, 1)
  return { minutes: 0, at: `${tomorrow}T00:00:00+08:00`, dayOffset: 1 }
}

/**
 * 规划今天几点跑：工作日只选在 [00:00,09:00) / [12:00,14:00) / [18:00,24:00) 内，
 * 周末与法定节假日全天可选；5 分钟粒度随机。给 DSH 定时任务用。
 *
 * 补跑机制：今天还没跑过（lastAutoRunAt 不是今天）→ catchUp=true，
 * 立刻取「现在」之后最近的 5 分钟整数倍空闲时刻补跑（仍避开高峰）。
 * 注意：错过一整天且当天从未开机的情况无法补，属于设计边界。
 */
async function cmdPlan(args) {
  const state = ensureStateSkeleton()
  const now = beijingParts()
  const dayInfo = await getDayInfo(now.dateStr)
  const skipChance = clamp01(args['skip-chance'] ?? state.config.scheduleSkipChance ?? 0)
  const roll = Math.random()
  const skip = roll < skipChance
  const { decay, decision } = decayInfo(state)
  // 衰减判定不该推荐的今天，直接跳过（off 暂停 / low 隔天）
  const decayBlocks = !decision.share
  // --catchup：检测到「今天该跑但错过了」时的补救模式。
  //   现在非高峰 → 立刻跑；现在高峰 → 等到高峰结束（最近的 5 分钟整点）立刻跑。
  const catchupMode = Boolean(args.catchup)

  let slot = null
  let catchupNote = ''
  if (!skip && !decayBlocks) {
    if (catchupMode) {
      const target = Math.ceil((now.minutes + 3) / 5) * 5
      const m = nonPeakMinute(dayInfo, target)
      if (m != null) {
        slot = { minutes: m, at: `${now.dateStr}T${fmtMinutes(m)}:00+08:00` }
        catchupNote = m > now.minutes + 5 ? `（现在高峰，${fmtMinutes(m)} 高峰结束后立刻跑）` : ''
      }
    } else {
      slot = pickRandomSlot(dayInfo, now.dateStr, now.minutes, { minLead: 3 })
      if (!slot) {
        // 正常排程但今天已无剩余时段（例如 23:58 之后）：顺延到明天 00:00
        const tomorrow = shiftDate(now.dateStr, 1)
        slot = { minutes: 0, at: `${tomorrow}T00:00:00+08:00` }
      }
    }
  }

  const plan = {
    date: now.dateStr,
    now: fmtMinutes(now.minutes),
    dayType: dayInfo.kind,
    dayName: dayInfo.name || '',
    daySource: dayInfo.source,
    peakText: PEAK_TEXT,
    preferredText: PREFERRED_TEXT,
    skip: skip || decayBlocks,
    catchup: catchupMode,
    isPeakNow: isPeak(dayInfo, now.minutes),
    at: slot ? slot.at : null,
    minutes: slot ? slot.minutes : null,
    roll: Number(roll.toFixed(3)),
    skipChance,
    decay: {
      mode: decay.mode,
      everyNDays: decay.everyNDays,
      daysSinceInteraction: decay.daysSinceInteraction,
      lastInteractionAt: decay.lastInteractionAt,
      reason: decay.reason,
    },
    shareToday: decision.share,
    description: decayBlocks
      ? `🚫 今天不推荐：${decision.reason}`
      : describePlan({ dayInfo, dateStr: now.dateStr, skip, slot, catchup: catchupMode }) + catchupNote,
  }
  state.schedule = { ...plan, plannedAt: new Date().toISOString() }
  saveState(state)
  console.log(plan.description)
  printResult({ ok: true, ...plan })
}

/** 判断「现在」是否处于 DeepSeek 高峰；定时任务先跑它，blocked=true 就不要跑 */
async function cmdGuard() {
  const now = beijingParts()
  const state = ensureStateSkeleton()
  const dayInfo = await getDayInfo(now.dateStr)
  const blocked = isPeak(dayInfo, now.minutes)
  const { decay, decision } = decayInfo(state)
  // 补跑用的「最近非高峰时刻」：现在就在非高峰 → 立刻（返回 now 向上取整的 5 分钟点）
  const nextPeakFree = nonPeakMinute(dayInfo, now.minutes)
  const nextAllowed =
    nextPeakFree == null ? null : `${now.dateStr}T${fmtMinutes(nextPeakFree)}:00+08:00`
  const shouldShare = decision.share && !blocked
  console.log(
    blocked
      ? `⛔ 现在是 DeepSeek 高峰（${PEAK_TEXT}），不跑；等到 ${nextPeakFree != null ? fmtMinutes(nextPeakFree) : '下一个空闲时段'} 再立刻跑`
      : decision.share
        ? '✅ 现在不在高峰期（非高峰），可以立刻跑'
        : `🚫 今天不该推荐：${decision.reason}`,
  )
  printResult({
    ok: true,
    blocked,
    shouldShare,
    peakFree: !blocked,
    decay: {
      mode: decay.mode,
      everyNDays: decay.everyNDays,
      daysSinceInteraction: decay.daysSinceInteraction,
      lastInteractionAt: decay.lastInteractionAt,
      reason: decay.reason,
    },
    shareDecision: decision.reason,
    date: now.dateStr,
    now: fmtMinutes(now.minutes),
    dayType: dayInfo.kind,
    dayName: dayInfo.name || '',
    daySource: dayInfo.source,
    peakText: PEAK_TEXT,
    preferredText: PREFERRED_TEXT,
    nextAllowed,
  })
}

// ── prompt / watch（点评提示词 + 实时私信监听）────────────────────────────

async function cmdPrompt(args) {
  const state = ensureStateSkeleton()
  const kind = args._[0] || 'review'
  if (kind !== 'review') die('用法：prompt review --bvid BV...')
  const bvid = args.bvid
  if (!bvid) die('缺少 --bvid')
  let video = (state.candidates || []).find((c) => c.bvid === bvid)
  const jar = await getJar()
  if (!video) {
    video = await videoDetail(jar, bvid)
    video.comments = await topComments(jar, { aid: video.aid, ps: 6 })
  }
  if (!video.enrich) {
    try {
      const { enrichVideo } = await import('./enrich.mjs')
      await enrichVideo(jar, video, { withSubtitles: true, withDanmaku: true, withCover: false })
    } catch {
      /* 素材不全也能写点评，提示词里会注明 */
    }
  }
  const persona = loadPersona(state.config)
  const reviewPrompt = loadReviewPrompt(state.config)
  const prompt = buildReviewPrompt(video, {
    persona,
    reviewPrompt: reviewPrompt.text,
    maxChars: Number(state.config.reviewMaxChars) || 480,
    // 自动轮也提醒她记日记（重置时两本日记会带进新会话）
    extra: `【日记】这轮如果看到让你觉得有意思的东西，写进日记（不强制，一两句话）：node "${cliPath()}" diary add --text "..."（私密加 --private）。`,
  })
  const file = path.join(STATE_DIR, 'prompt-review.md')
  fs.writeFileSync(file, prompt, 'utf8')
  console.log(prompt)
  console.log(`\n提示词来源：${reviewPrompt.source}；已写入 ${file}`)
  console.log('把生成的点评用 `pick --review "..."` 带上，或者用于私信回复。')
  printResult({
    ok: true,
    kind: 'review',
    bvid,
    promptPath: file,
    promptSource: reviewPrompt.source,
    video: { title: video.title, owner: video.owner },
  })
}

const PENDING_FILE = path.join(STATE_DIR, 'inbox-pending.json')
const WATCH_CURSOR_FILE = path.join(STATE_DIR, 'watch-cursor.json')
const WATCH_LOG = path.join(STATE_DIR, 'watch.log')

function readPending() {
  try {
    const list = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function writePending(list) {
  ensureDirs()
  fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2), 'utf8')
}

function watchLog(line) {
  try {
    ensureDirs()
    fs.appendFileSync(WATCH_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败不影响监听 */
  }
}

/** 读取/清空待处理私信队列（Windows 常驻 watcher 写入，DSH 定时提醒消费） */
async function cmdPending(args) {
  ensureStateSkeleton()
  const pending = readPending()
  if (args.clear) {
    writePending([])
    console.log('已清空 pending 队列')
    printResult({ ok: true, cleared: true })
    return
  }
  if (!pending.length) {
    console.log('没有待处理私信。')
  } else {
    console.log(`有 ${pending.length} 条待处理私信：`)
    for (const msg of pending) {
      console.log(`- [${new Date((msg.ts || 0) * 1000).toLocaleString()}] ${truncate(msg.text || msg.shareBvid || '', 100)}`)
    }
  }
  printResult({ ok: true, count: pending.length, pending })
}

/**
 * 监听私信。
 * - 默认：轮询到「本人新消息」就退出（DSH 后台任务模式，退出即唤醒 agent）。
 * - --daemon：常驻轮询，新消息写入 state/inbox-pending.json 队列后继续跑（Windows 计划任务用）。
 */
async function cmdWatch(args) {
  const state = ensureStateSkeleton()
  const daemon = Boolean(args.daemon)
  const interval = Math.max(15, Math.min(600, Number(args.interval) || Number(state.config.watchInterval) || 60))
  const timeoutSeconds = Math.max(60, Number(args.timeout) || 4 * 3600)
  // 注意：比的是 Date.now() 毫秒，必须把秒换算成毫秒，否则会 14 秒就退出
  const timeoutMs = timeoutSeconds * 1000
  const jar = await getJar()
  const info = await checkLogin(jar.toObject())
  if (!info || !info.isLogin) die('登录态无效，先 login')
  const ownerUid = Number(state.config.targetUid) || Number(info.uid)
  const startedAt = Date.now()

  let cursorTs = Number(state.inboxAckTs) || 0
  try {
    const saved = JSON.parse(fs.readFileSync(WATCH_CURSOR_FILE, 'utf8'))
    cursorTs = Math.max(cursorTs, Number(saved.ts) || 0)
  } catch {
    /* 首次运行没有游标 */
  }

  console.log(
    daemon
      ? `常驻监听启动：每 ${interval}s 轮询，新消息写入 state/inbox-pending.json`
      : `开始监听私信（每 ${interval}s 轮询一次，最长 ${Math.round(timeoutSeconds / 60)} 分钟）……`,
  )
  if (daemon) watchLog(`daemon start interval=${interval} ownerUid=${ownerUid} cursor=${cursorTs}`)

  let beats = 0
  while (daemon || Date.now() - startedAt < timeoutMs) {
    try {
      const inbox = await inboxNew(jar.toObject(), { sinceTs: cursorTs, ownerUid })
      const msgs = (inbox.fromOwner || []).filter((msg) => Number(msg.ts) > cursorTs)
      if (msgs.length) {
        cursorTs = Math.max(cursorTs, ...msgs.map((msg) => Number(msg.ts) || 0))
        fs.writeFileSync(
          WATCH_CURSOR_FILE,
          JSON.stringify({ ts: cursorTs, at: new Date().toISOString() }),
          'utf8',
        )
        if (daemon) {
          const current = readPending()
          const known = new Set(current.map((msg) => msg.msgKey))
          const fresh = msgs.filter((msg) => !known.has(msg.msgKey))
          writePending(current.concat(fresh.map((msg) => ({ ...msg, queuedAt: new Date().toISOString() }))))
          watchLog(`queued ${fresh.length} message(s): ${fresh.map((msg) => msg.msgKey).join(',')}`)
          console.log(`收到 ${fresh.length} 条新私信，已入队 ${PENDING_FILE}`)
        } else {
          console.log('收到新私信：')
          for (const msg of msgs) {
            console.log(`- [${new Date(msg.ts * 1000).toLocaleString()}] ${truncate(msg.text || msg.shareBvid || '', 120)}`)
          }
          printResult({
            ok: true,
            messages: msgs,
            othersCount: inbox.othersCount || 0,
            waitedSeconds: Math.round((Date.now() - startedAt) / 1000),
          })
          return
        }
      }
    } catch (error) {
      console.log(`轮询失败（继续）：${error.message}`)
      if (daemon) watchLog(`poll error: ${error.message}`)
    }
    beats++
    if (daemon && beats % 10 === 0) watchLog(`heartbeat beats=${beats} cursor=${cursorTs}`)
    await sleep(interval * 1000)
  }
  console.log('监听超时，没有新私信。')
  printResult({ ok: true, timedOut: true, waitedSeconds: Math.round((Date.now() - startedAt) / 1000) })
}

// ── status / demo / wake ───────────────────────────────────────────────────

async function cmdStatus() {
  const state = ensureStateSkeleton()
  const config = state.config
  let login = { isLogin: false }
  try {
    if (state.cookies) {
      const jar = await getJar()
      login = await checkLogin(jar.toObject())
    }
  } catch (error) {
    login = { isLogin: false, error: error.message }
  }
  const info = {
    ok: true,
    loggedIn: !!login.isLogin,
    uname: login.uname || null,
    uid: login.uid || null,
    config: {
      targetUid: config.targetUid || null,
      dailyLimit: config.dailyLimit,
      dryRun: config.dryRun !== false,
      personaPath: config.personaPath || null,
    },
    counts: {
      candidates: (state.candidates || []).length,
      picks: (state.picks || []).length,
      sentToday: countSentToday(state),
      seen: Object.keys(state.seen || {}).length,
    },
    lastScanAt: state.lastScanAt || null,
    lastSendAt: state.lastSendAt || null,
    lastAutoRunAt: state.lastAutoRunAt || null,
    mood: moodLib.moodSummary(moodLib.loadMood()),
    impressions: impressionLib.impressionStats(),
    speech: speechLib.speechStats(),
    life: lifeLib.lifeStats(),
    decay: (() => {
      const d = decayInfo(state)
      return { mode: d.decay.mode, daysSinceInteraction: d.decay.daysSinceInteraction, shareToday: d.decision.share, reason: d.decision.reason }
    })(),
    stateDir: STATE_DIR,
  }
  console.log(`登录：${info.loggedIn ? `✅ ${info.uname}（uid=${info.uid}）` : '❌ 未登录（运行 login）'}`)
  console.log(
    `配置：目标 uid=${info.config.targetUid ?? '自己'}｜每日上限 ${info.config.dailyLimit}｜dryRun=${info.config.dryRun}｜自动推荐 ${config.autoRecommendations === true ? '开' : '停用'}`,
  )
  console.log(`计数：候选 ${info.counts.candidates}｜已挑 ${info.counts.picks}｜今日已发 ${info.counts.sentToday}`)
  console.log(
    `心情：${info.mood.label}${info.mood.blend && info.mood.blend.length ? ` · ${info.mood.blend.join('、')}` : ''}${info.mood.quiet ? '（不想说话）' : ''}｜印象 ${info.impressions.count}｜说过 ${info.speech.count} 条`,
  )
  console.log(`生活：当前周期 ${info.life.cycle}｜今天已活动 ${info.life.hoursToday.length} 次｜计划 ${info.life.plans.length} 条｜印象 ${info.impressions.count}`)
  printResult(info)
}

async function cmdDemo(args) {
  console.log('=== demo：无需登录的端到端演示（只读推荐流 + 本地报告）===')
  ensureStateSkeleton()
  const jar = new CookieJar()
  const feed = await rcmdFeed(jar, { ps: 8 })
  const items = (feed.items || []).slice(0, 6)
  if (!items.length) die('推荐流为空，稍后重试')
  console.log(`拉到 ${items.length} 条，补详情……`)
  const detailed = []
  for (const item of items) {
    try {
      detailed.push(await enrichCandidate(jar, item, { withComments: true }))
    } catch (error) {
      console.log(`跳过 ${item.bvid}：${error.message}`)
    }
  }
  const state = ensureStateSkeleton()
  const ranked = rankCandidates(detailed, state.config, {})
  const picks = ranked.slice(0, 2).map((c) => autoPick(c, state.config))
  const date = `demo-${today()}`
  const digest = await writeDigest(state, { date, picks, scannedCount: detailed.length, mode: 'demo' })
  for (const p of picks) {
    console.log(`\n· ${p.title}（${p.owner}，${fmtDuration(p.duration)}）`)
    console.log(`  ${p.verdict}：${p.oneLiner}`)
    console.log(`  ${p.url}`)
  }
  console.log(`\n报告：${digest.mdPath}`)
  console.log(`卡片墙：${digest.htmlPath}`)
  printResult({ ok: true, picks: picks.map((p) => p.bvid), ...digest })
}

/** 随机唤醒：30% 概率「今天不想看」；用于 DSH 定时任务调用 */
async function cmdWake(args) {
  const state = ensureStateSkeleton()
  const skipRate = Number(args.skip ?? 0.3)
  if (Math.random() < skipRate) {
    console.log('🐟 今天不想看，跳过这一轮。')
    printResult({ ok: true, skipped: true, reason: 'random' })
    return
  }
  console.log('🐟 醒了，开始刷。')
  await cmdScan(args)
}

// ── diary / session（两本日记 + 会话重置）─────────────────────────────────

function diaryScope(args) {
  return args.private || args.scope === 'private' ? 'private' : 'public'
}

function sessionLimits(config) {
  // 0 = 关闭这一项（一天一个对话）；只有 >0 才按轮数/字符换会话
  return {
    rounds: Number(config.sessionResetRounds) || 0,
    chars: Number(config.sessionResetChars) || 0,
  }
}

async function cmdDiary(args) {
  const sub = args._[0] || 'status'
  const scope = diaryScope(args)

  if (sub === 'add') {
    const text = args.text || args._.slice(1).join(' ')
    if (!text) die('缺少 --text "..."')
    let result
    try {
      result = diary.appendEntry(scope, { text, title: args.title || '', bvid: args.bvid || '' })
    } catch (error) {
      die(error.message)
    }
    console.log(
      `${result.duplicate ? '内容重复，没有重复写：' : '已写进'}${diary.scopeMeta(scope).label}：${result.file}`,
    )
    printResult({ ok: true, ...result })
    return
  }

  if (sub === 'read') {
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
    const entries = diary.readEntries(scope)
    const shown = entries.slice(-limit)
    console.log(
      `${diary.scopeMeta(scope).label}：共 ${entries.length} 条，显示最近 ${shown.length} 条（${diary.diaryFile(scope)}）`,
    )
    for (const entry of shown) console.log(`\n## ${entry.stamp} · ${entry.title}\n${entry.body}`)
    printResult({ ok: true, scope, count: entries.length, shown: shown.length, file: diary.diaryFile(scope), entries: shown })
    return
  }

  if (sub === 'pack') {
    const state = ensureStateSkeleton()
    const pack = buildMemoryPack({ cfg: state.config, cli: cliPath(), home: biliHome() })
    const file = path.join(STATE_DIR, 'memory-pack.md')
    fs.writeFileSync(file, `${pack}\n`, 'utf8')
    console.log(pack)
    printResult({ ok: true, packPath: file, chars: pack.length, diaries: diary.diaryStats() })
    return
  }

  const stats = diary.diaryStats()
  console.log('两本日记：')
  for (const info of Object.values(stats)) {
    console.log(`  ${info.label}：${info.entries} 条 / ${info.chars} 字符${info.last ? ` / 最近 ${info.last}` : ''}`)
    console.log(`    ${info.file}`)
  }
  const recent = diary.readEntries('public').slice(-3)
  if (recent.length) {
    console.log('\n公开日记最近几条（主人可以看）：')
    for (const entry of recent) console.log(`  · ${entry.stamp} · ${entry.title}`)
  }
  console.log('\n看公开日记：node src/cli.mjs diary read')
  console.log('读私密日记：node src/cli.mjs diary read --private（只有她自己会读）')
  printResult({ ok: true, ...stats })
}

function sessionTurnFail(args, message) {
  const result = { ok: false, error: message }
  if (args.out) {
    try {
      fs.writeFileSync(path.resolve(args.out), `RESULT_JSON: ${JSON.stringify(result)}\n`, 'utf8')
    } catch {
      /* 写不了就只打 stderr */
    }
  }
  die(message)
}

async function cmdSession(args) {
  const sub = args._[0] || 'status'
  const state = ensureStateSkeleton()

  if (sub === 'turn') {
    let payload
    try {
      if (args.input) payload = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'))
      else if (args.stdin) payload = JSON.parse(fs.readFileSync(0, 'utf8'))
      else {
        payload = {
          key: args.key || 'owner',
          base: args.base || 'bili-lite-dm',
          messages: [{ text: args.text || '' }],
        }
      }
    } catch (error) {
      return sessionTurnFail(args, `session turn 的输入不是合法 JSON：${error.message}`)
    }
    if (!payload || !payload.key || !payload.base) return sessionTurnFail(args, 'session turn 需要 key 与 base')
    let peak = false
    if (String(payload.key) !== 'owner') {
      try {
        const now = new Date()
        const dayInfo = await getDayInfo(beijingParts(now).dateStr)
        peak = isPeak(dayInfo, beijingParts(now).minutes)
      } catch {
        /* 判断不了就当非高峰 */
      }
    }
    let turn
    try {
      turn = buildTurn({
        key: String(payload.key),
        base: String(payload.base),
        messages: Array.isArray(payload.messages) ? payload.messages : [],
        sender: payload.sender,
        cfg: state.config,
        limits: sessionLimits(state.config),
        cli: cliPath(),
        writeState: !args['dry-run'],
        peak,
      })
    } catch (error) {
      return sessionTurnFail(args, `session turn 失败：${error.message}`)
    }
    console.error(
      turn.skip
        ? '[session] skip (peak)'
        : `[session] ${turn.sessionId} epoch=${turn.epoch} reset=${turn.reset} reason=${turn.reason || '-'} turns=${turn.turns} chars=${turn.contextChars}`,
    )
    const result = { ok: true, ...turn }
    // 插件用 --input/--out 走文件（宿主进程可能不允许管道）；命令行手动调用仍打印到 stdout
    if (args.out) {
      try {
        fs.writeFileSync(path.resolve(args.out), `RESULT_JSON: ${JSON.stringify(result)}\n`, 'utf8')
      } catch (error) {
        console.error(`写 --out 失败：${error.message}`)
      }
    }
    printResult(result)
    return
  }

  if (sub === 'reset') {
    const key = args.key || 'owner'
    const base =
      args.base || (key === 'owner' ? 'bili-lite-dm' : `bili-lite-dm-u${String(key).replace(/^u/, '')}`)
    const record = markReset(key, { base })
    console.log(`已标记 ${key}：下一轮换新会话（当前 ${record.sessionId}，第 ${record.epoch} 次）`)
    printResult({ ok: true, key, base, record })
    return
  }

  const limits = sessionLimits(state.config)
  const store = loadSessions()
  console.log(`会话状态文件：${sessionsFile()}`)
  console.log(
    limits.rounds > 0 || limits.chars > 0
      ? `阈值：${limits.rounds || '不按轮数'} 轮 / ${limits.chars || '不按字符'} 字符`
      : '阈值：已关闭（一天一个对话，跨天才换新会话）',
  )
  console.log(resetCardText(limits))
  const keys = Object.keys(store.sessions)
  if (!keys.length) console.log('\n还没有会话记录：下一条私信会自动开新会话并注入人设 + 两本日记。')
  const rows = []
  for (const key of keys) {
    const record = store.sessions[key]
    const info = inspectSession(record.sessionId)
    const row = {
      key,
      sessionId: record.sessionId,
      epoch: record.epoch,
      forceReset: Boolean(record.forceReset),
      resetReason: record.resetReason || null,
      exists: info.exists,
      turns: info.turns,
      contextChars: info.contextChars,
    }
    rows.push(row)
    console.log(
      `\n${key}：${record.sessionId}（第 ${record.epoch} 次）${record.forceReset ? ' · 已请求下一轮重置' : ''}`,
    )
    console.log(`  ${info.exists ? `${info.turns} 轮 / 约 ${info.contextChars} 字符` : '日志还没生成（下一条消息会创建）'}`)
  }
  printResult({ ok: true, limits, stateFile: sessionsFile(), sessions: rows })
}

// ── mood / impressions / speech / memory / life / dynamic ─────────────────

function writeResultFile(args, result) {
  if (!args.out) return
  try {
    fs.writeFileSync(path.resolve(args.out), `RESULT_JSON: ${JSON.stringify(result)}\n`, 'utf8')
  } catch (error) {
    console.error(`写 --out 失败：${error.message}`)
  }
}

async function cmdMood(args) {
  const sub = args._[0] || 'status'
  if (sub === 'set') {
    const input = {
      label: args.label,
      note: args.note,
      blend: args.blend,
      why: args.why || '',
      source: args.source || 'set',
    }
    for (const axis of moodLib.MOOD_AXES) if (args[axis] !== undefined) input[axis] = Number(args[axis])
    const hasAxis = moodLib.MOOD_AXES.some((axis) => input[axis] !== undefined)
    if (!input.label && !input.note && !input.blend && !hasAxis) {
      die('mood set 需要 --label / --note / --blend / --energy 等至少一项')
    }
    const next = moodLib.setMood(input)
    console.log(moodLib.moodText(next))
    printResult({ ok: true, mood: moodLib.moodSummary(next), logged: true })
    return
  }
  if (sub === 'adjust') {
    const input = {
      source: args.source || 'manual',
      why: args.why || '',
      blend: args.blend,
      note: args.note,
    }
    for (const axis of moodLib.MOOD_AXES) if (args[axis] !== undefined) input[axis] = Number(args[axis])
    const result = moodLib.adjustMood(input)
    if (!result.ok) {
      console.error(result.message || `心情没调成：${result.reason}`)
      printResult({ ok: false, ...result })
      return
    }
    console.log(moodLib.moodText(result.mood))
    printResult({ ok: true, ...result })
    return
  }
  if (sub === 'history') {
    const days = Math.max(1, Math.min(365, Number(args.days) || 7))
    const axis = args.axis || 'all'
    const entries = moodLib.moodHistory({ days })
    console.log(moodLib.renderMoodHistory(entries, { axis }))
    let htmlPath = null
    if (args.html) {
      const html = moodLib.buildMoodHistoryHtml(entries)
      fs.mkdirSync(path.dirname(moodLib.MOOD_HISTORY_HTML), { recursive: true })
      fs.writeFileSync(moodLib.MOOD_HISTORY_HTML, html, 'utf8')
      htmlPath = moodLib.MOOD_HISTORY_HTML
      console.log(`\n曲线已写入：${htmlPath}`)
    }
    printResult({ ok: true, count: entries.length, days, axis, htmlPath })
    return
  }
  if (sub === 'drift') {
    const next = moodLib.driftMood(moodLib.loadMood())
    console.log(moodLib.moodText(next))
    printResult({ ok: true, mood: moodLib.moodSummary(next) })
    return
  }
  const current = moodLib.loadMood()
  console.log(moodLib.moodText(current))
  printResult({ ok: true, mood: moodLib.moodSummary(current) })
}

async function cmdImpressions(args) {
  const sub = args._[0] || 'list'
  if (sub === 'add') {
    const result = impressionLib.addImpression({
      title: args.title || '',
      author: args.author || '',
      bvid: args.bvid || '',
      content: args.content || '',
      comment: args.comment || '',
      why: args.why || '',
      mood: args.mood || moodLib.loadMood().label,
      tags: args.tags ? String(args.tags).split(/[,，\s]+/).filter(Boolean) : [],
      source: args.source || 'life',
    })
    console.log(result.duplicate ? `这条印象已经记过了：${result.item.title}` : `记下了：${result.item.title || result.item.why}`)
    printResult({ ok: true, ...result })
    return
  }
  if (sub === 'recall') {
    const items = impressionLib.recallImpressions({
      limit: Number(args.limit) || 4,
      topic: args.topic || '',
      mood: args.mood || moodLib.loadMood().label,
    })
    console.log(impressionLib.renderRecall(items))
    printResult({ ok: true, items, text: impressionLib.renderRecall(items) })
    return
  }
  if (sub === 'pin' || sub === 'unpin') {
    const id = args.id || args._[1]
    if (!id) die('缺少 --id')
    const result = impressionLib.pinImpression(id, sub === 'pin')
    if (!result.ok) die(result.error)
    printResult({ ok: true, ...result })
    return
  }
  const items = impressionLib.loadImpressions().slice(-Math.max(1, Number(args.limit) || 10))
  for (const item of items) console.log(`- ${item.at} · ${item.title}${item.author ? ` · ${item.author}` : ''}`)
  printResult({ ok: true, items, stats: impressionLib.impressionStats() })
}

async function cmdSpeech(args) {
  const sub = args._[0] || 'recent'
  const channel = args.channel || undefined
  const to = args.to !== undefined ? String(args.to) : undefined
  if (sub === 'brief') {
    const text = speechLib.renderSpeechBrief({ channel, to, limit: Number(args.limit) || 4 })
    console.log(text || '（还没有说过什么。）')
    printResult({ ok: true, text })
    return
  }
  if (sub === 'check') {
    const text = args.text || ''
    if (!text) die('缺少 --text')
    const result = speechLib.checkSpeech(text, { channel: channel || 'dm-owner', to })
    for (const warning of result.warnings) console.log(`⚠ ${warning}`)
    if (!result.warnings.length) console.log('没有发现明显的复读/照读。')
    printResult({ ok: true, ...result })
    return
  }
  if (sub === 'profile') {
    const profile = speechLib.speechProfile({ channel })
    console.log(JSON.stringify(profile, null, 2))
    printResult({ ok: true, profile })
    return
  }
  const items = speechLib.recentSpeech({ channel, to, limit: Number(args.limit) || 10 })
  for (const item of items) {
    const label =
      item.proactive ? '主动' : item.channel === 'dynamic' ? '动态' : item.channel === 'comment' ? '评论' : '说过'
    console.log(`[${item.at}]（${label}）${item.text}`)
  }
  printResult({ ok: true, items, stats: speechLib.speechStats() })
}

/** 评论台账：每条 = 视频链接 + 评论内容（state/comments.md） */
async function cmdComments(args) {
  const sub = args._[0] || 'list'
  if (sub === 'file' || sub === 'path') {
    console.log(commentsLib.ensureComments({}))
    printResult({ ok: true, file: commentsLib.commentsFile({}) })
    return
  }
  if (sub === 'stats') {
    const stats = commentsLib.commentsStats({})
    console.log(`评论 ${stats.entries} 条 / ${stats.videos} 个视频｜${stats.file}`)
    printResult({ ok: true, ...stats })
    return
  }
  const limit = Math.max(1, Math.min(200, Number(args.limit) || 20))
  const items = commentsLib.recentComments({ limit })
  if (!items.length) console.log(`还没有评论记录（发送成功会自动写到 ${commentsLib.commentsFile({})}）。`)
  for (const item of items) {
    console.log(`\n## ${item.stamp}`)
    console.log(item.url)
    console.log(item.text)
  }
  printResult({ ok: true, file: commentsLib.commentsFile({}), count: items.length, items })
}

async function cmdMemory(args) {
  const sub = args._[0] || 'stats'
  if (sub === 'due') {
    const due = memoryLib.memoryDue({})
    console.log(`due=${due.due}｜${due.reason}｜建议整理 ${due.suggestedMonth}`)
    printResult({ ok: true, ...due })
    return
  }
  if (sub === 'plan') {
    const month = args.month || memoryLib.previousMonth()
    const plan = memoryLib.consolidationPlan({ month })
    console.log(JSON.stringify(plan, null, 2))
    writeResultFile(args, { ok: true, plan })
    printResult({ ok: true, month, plan })
    return
  }
  if (sub === 'consolidate') {
    const month = args.month || memoryLib.previousMonth()
    const keep = String(args.keep || '')
      .split(/[,，\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
    const result = memoryLib.consolidate({
      month,
      keep,
      summary: args.summary || '',
      now: new Date(),
    })
    console.log(result.empty ? `这个月（${month}）没有可整理的内容。` : `整理完成：留 ${JSON.stringify(result.kept)}，忘 ${JSON.stringify(result.forgotten)}。归档：${result.archive}`)
    printResult({ ok: true, ...result })
    return
  }
  if (sub === 'pin' || sub === 'unpin') {
    const id = args.id || args._[1]
    if (!id) die('缺少 --id')
    const result = memoryLib.pinMemory(id, sub === 'pin')
    if (!result.ok) die(result.error)
    printResult({ ok: true, ...result })
    return
  }
  if (sub === 'summary') {
    const stats = memoryLib.memoryStats()
    console.log(stats.summary || '（还没有月度总结）')
    printResult({ ok: true, summary: stats.summary })
    return
  }
  if (sub === 'archive-list') {
    const dirs = fs.existsSync(memoryLib.MEMORY_DIR) ? fs.readdirSync(memoryLib.MEMORY_DIR) : []
    printResult({ ok: true, archives: dirs, dir: memoryLib.MEMORY_DIR })
    return
  }
  const stats = memoryLib.memoryStats()
  const pending = memoryLib.pendingMonth({})
  console.log(`记忆：${JSON.stringify(stats.counts)}｜pinned ${stats.pins}｜上次整理 ${stats.lastConsolidatedAt || '还没'}`)
  console.log(
    `待整理：${pending.month}（${pending.entries} 条）｜遗忘规则：每月 1 号 02:00 后，留 63%、最近 7 天和 pinned 不动`,
  )
  console.log(`归档：${stats.archiveDir}`)
  printResult({ ok: true, ...stats, pending })
}

async function cmdLife(args) {
  const sub = args._[0] || 'status'
  // 每次 life tick/prompt 顺手清掉超过 1 天的抽帧图片（旧图不长期占盘）
  cleanupFrames()
  if (sub === 'prompt') {
    // 把这一轮的完整提示词落成文件，插件/DSH 注入时发一句「读这个文件」即可（省 token）
    const id = args.id || ''
    const file = id ? lifeLib.loadLife({}).plans.find((item) => item.id === id) : lifeLib.currentPlan({})
    if (!file) die('没有这次活动：给 --id 或先让 tick 叫醒')
    const text = lifeLib.executePrompt(file)
    const out = args.out || path.join(process.env.BILI_LITE_HOME || '.', 'state', 'life-prompt.md')
    fs.writeFileSync(path.resolve(out), `${text}\n`, 'utf8')
    console.log(`已写入 ${path.resolve(out)}（${text.length} 字符）`)
    printResult({ ok: true, path: path.resolve(out), chars: text.length, planId: file.id })
    return
  }
  if (sub === 'context') {
    const context = lifeLib.lifeContext({})
    console.log(moodLib.moodText(context.mood))
    console.log(impressionLib.renderRecall(context.impressions))
    console.log(`计划：${context.plan ? `${context.plan.at} · ${context.plan.intent}` : '没有'}`)
    printResult({ ok: true, ...context })
    return
  }
  if (sub === 'plan') {
    const now = new Date()
    const dayInfo = await getDayInfo(beijingParts(now).dateStr)
    const plan = lifeLib.addPlan({
      slot: args.slot || '',
      intent: args.intent || '',
      activity: args.activity || 'watch',
      at: args.at || '',
      target: args.target || '',
      now,
      dayInfo,
    })
    // --no-wake：只要计划 + 提示词文件，不要自动注入回合（插件到那小时 tick 时才注入）
    if (args['no-wake']) {
      const prompt = lifeLib.executePrompt(plan, { now })
      const out = args.out || path.join(process.env.BILI_LITE_HOME || '.', 'state', 'life-prompt.md')
      fs.writeFileSync(path.resolve(out), `${prompt}\n`, 'utf8')
      writeResultFile(args, { ok: true, plan, promptPath: path.resolve(out), prompt })
      console.log(`计划 ${plan.id}：${plan.at} · ${plan.activity} · ${plan.intent}（提示词已写到 ${path.resolve(out)}）`)
      printResult({ ok: true, plan, promptPath: path.resolve(out), action: 'none', sessionId: lifeLib.lifeSessionId(now) })
      return
    }
    if (!args['no-wake']) {
      const prompt = lifeLib.actPrompt(plan, { now })
      writeResultFile(args, { ok: true, action: 'act', slot: plan.slot, plan, prompt, sessionId: lifeLib.lifeSessionId(now) })
      console.log(`计划 ${plan.id}：${plan.at} · ${plan.activity} · ${plan.intent}`)
      printResult({ ok: true, action: 'act', slot: plan.slot, plan, prompt, sessionId: lifeLib.lifeSessionId(now) })
    } else {
      printResult({ ok: true, plan, action: 'none' })
    }
    return
  }
  if (sub === 'finish' || sub === 'skip') {
    const id = args.id || args._[1]
    if (!id) die('缺少 --id')
    const result = lifeLib.finishPlan(id, {
      result: args.result || '',
      status: sub === 'skip' ? 'skipped' : args.status || 'done',
    })
    if (!result.ok) die(result.error)
    printResult({ ok: true, ...result })
    return
  }
  if (sub === 'tick') {
    const state = ensureStateSkeleton()
    if (state.config.lifeEnabled === false) {
      const result = { ok: true, action: 'none', reason: 'disabled' }
      writeResultFile(args, result)
      printResult(result)
      return
    }
    const now = new Date()
    const dayInfo = await getDayInfo(beijingParts(now).dateStr)
    const peak = isPeak(dayInfo, beijingParts(now).minutes)
    const tick = lifeLib.lifeTick({ now, dayInfo, peak })
    // 刷视频一天一个对话：不管 act / execute，都注入当天那一个会话（跨天才换）
    const result = { ok: true, ...tick, sessionId: lifeLib.lifeSessionId(now) }
    writeResultFile(args, result)
    console.error(`[life] action=${result.action} cycle=${result.cycle} peak=${result.peak}${result.slot ? ` slot=${result.slot}` : ''} session=${result.sessionId}`)
    printResult(result)
    return
  }
  if (sub === 'recall') {
    const items = impressionLib.recallImpressions({
      limit: Number(args.limit) || 4,
      topic: args.topic || '',
      mood: args.mood || moodLib.loadMood().label,
    })
    const text = impressionLib.renderRecall(items)
    const brief = speechLib.renderSpeechBrief({ channel: 'dm-owner', limit: 3 })
    console.log(text)
    printResult({ ok: true, items, text, brief })
    return
  }
  if (sub === 'say') {
    return cmdReply({ ...args, proactive: true })
  }
  if (sub === 'action') {
    const type = (args._[1] || '').toLowerCase()
    if (!type) die('用法：life action like|fav|coin|follow|unfollow|bangumi|dynamic ...（评论已停用）')
    if (type === 'comment') die('评论功能已停用（2026-10-26 起）')
    let coins = null
    if (type === 'coin') coins = await coinBalance()
    const cap = lifeLib.canAct(type, { coins })
    if (!cap.ok) die(cap.reason)
    let result
    if (type === 'like') {
      if (!args.bvid) die('缺少 --bvid')
      result = await likeByBvid(args.bvid)
    } else if (type === 'fav') {
      if (!args.bvid) die('缺少 --bvid')
      result = await favByBvid(args.bvid, {
        folderName: args.folder || '海底',
        isPublic: !args.private,
      })
    } else if (type === 'coin') {
      if (!args.bvid) die('缺少 --bvid')
      result = await coinByBvid(args.bvid)
    } else if (type === 'follow') {
      if (!args.mid) die('缺少 --mid')
      result = await followMid(args.mid)
    } else if (type === 'unfollow') {
      if (!args.mid) die('缺少 --mid')
      result = await unfollowMid(args.mid)
    } else if (type === 'bangumi') {
      if (!args.season) die('缺少 --season')
      result = await followBangumi(args.season)
    } else if (type === 'dynamic') {
      const text = args.text || ''
      if (!text) die('缺少 --text')
      const bvid = args.bvid || ''
      const image = args.image || ''
      const images = args.images ? String(args.images).split(/[,，]/).map((s) => s.trim()).filter(Boolean) : []
      const privacy = checkDynamicPrivacy(text)
      if (!privacy.ok) die(`动态隐私检查没通过：${privacy.warnings.join('；')}`)
      try {
        const check = speechLib.checkSpeech(text, { channel: 'dynamic' })
        for (const warning of check.warnings) console.error(`⚠ ${warning}`)
      } catch {
        /* 检查失败不影响发送 */
      }
      const posted = await postDynamic(text, {
        dryRun: Boolean(args['dry-run']),
        bvid,
        image,
        images,
      })
      if (!posted.ok) die(`发动态失败：${posted.message || posted.code}`)
      if (!posted.dryRun) {
        speechLib.logSpeech({
          channel: 'dynamic',
          text,
          proactive: true,
          mood: moodLib.loadMood().label,
        })
        memoryLib.addPublicStub({
          type: 'dynamic',
          note: `发过一条动态（${posted.kind || (bvid ? 'video' : image || images.length ? 'image' : 'text')}）`,
        })
      }
      result = { ...posted, action: 'dynamic' }
    } else if (type === 'comment') {
      if (!args.bvid) die('缺少 --bvid')
      const text = String(args.text || '').trim()
      if (!text) die('缺少 --text')
      if (text.length > 1000) die('评论太长（B 站单条上限 1000 字）')
      const privacy = checkDynamicPrivacy(text)
      if (!privacy.ok) die(`评论隐私检查没通过：${privacy.warnings.join('；')}`)
      try {
        const check = speechLib.checkSpeech(text, { channel: 'comment' })
        for (const warning of check.warnings) console.error(`⚠ ${warning}`)
      } catch {
        /* 检查失败不影响发送 */
      }
      const posted = await commentByBvid(args.bvid, text, { dryRun: Boolean(args['dry-run']) })
      if (!posted.ok) die(`发评论失败：${posted.message || posted.code}`)
      if (!posted.dryRun) {
        speechLib.logSpeech({
          channel: 'comment',
          text,
          proactive: false,
          mood: moodLib.loadMood().label,
          replyTo: args.bvid,
        })
        // 单独一本「评论台账」：视频链接 + 评论内容（用户要求，每条都记）
        const logged = commentsLib.appendComment({
          bvid: args.bvid,
          text,
          mood: moodLib.loadMood().label,
          rpid: posted.rpid || '',
        })
        console.error(`已记到评论台账：${logged.file}（第 ${logged.entries} 条）`)
        memoryLib.addPublicStub({ type: 'comment', note: `在 ${args.bvid} 下说过一句` })
      }
      result = { ...posted, action: 'comment' }
    } else {
      die(`未知动作：${type}`)
    }
    if (result.ok && !result.already && !result.dryRun) {
      lifeLib.noteAction(type)
      if (['follow', 'unfollow', 'fav', 'bangumi'].includes(type)) {
        memoryLib.addPublicStub({ type, note: type === 'fav' ? `收藏到 ${args.folder || '海底'}` : `${type} ${args.mid || args.season || args.bvid || ''}`.trim() })
      }
    }
    console.log(JSON.stringify(result))
    printResult({ ok: Boolean(result.ok), ...result })
    return
  }
  const stats = lifeLib.lifeStats({})
  console.log(`当前周期（${stats.cycle}）：${stats.plans.length} 条计划｜今天已活动 ${stats.hoursToday.length} 次｜心情 ${stats.mood}｜印象 ${stats.impressions.count}`)
  for (const plan of stats.plans) console.log(`- ${plan.at} ${plan.status} ${plan.intent}`)
  printResult({ ok: true, ...stats })
}

function resolveFramesRun(args) {
  if (args.dir) return path.resolve(String(args.dir))
  const bvid = args.bvid || args._[1]
  if (!bvid) die('缺少 --bvid 或 --dir')
  const dir = latestFrameRunDir(bvid)
  if (!dir) die(`找不到 ${bvid} 的抽帧目录，先跑 frames --bvid ${bvid} --no-vision`)
  return dir
}

/** frames --vision-only：对已有 run 目录补识图；默认一次 2 张，够 300s 终端。 */
async function cmdFramesVisionOnly(args) {
  const dir = resolveFramesRun(args)
  const model = args['vision-model'] || undefined
  const jsonOut = args['json-out'] ? path.resolve(String(args['json-out'])) : undefined
  const limit = args.limit !== undefined ? Number(args.limit) : 2
  const result = await runVisionForRun(dir, { limit, model, jsonOut })
  if (!result.ok) die(result.message)
  console.log(`本地识图：${result.done}/${result.total} 完成，剩 ${result.remaining}（本次 ${result.processed} 张）`)
  for (const item of result.items) {
    console.log(`识图 ${item.label || `表 ${item.index}`}: ${item.ok ? item.text : '失败：' + item.message}`)
  }
  printResult(result)
}

/** frames --vision-status：只读进度和已完成文本，不跑模型。 */
function cmdFramesVisionStatus(args) {
  const dir = resolveFramesRun(args)
  const jsonOut = args['json-out'] ? path.resolve(String(args['json-out'])) : undefined
  const result = visionStatusForRun(dir, { jsonOut })
  console.log(`识图进度：${result.done}/${result.total}，剩 ${result.remaining}`)
  if (result.text) console.log(result.text)
  printResult(result)
}

async function cmdFrames(args) {
  if (args['vision-status']) return cmdFramesVisionStatus(args)
  if (args['vision-only']) return cmdFramesVisionOnly(args)
  const bvid = args.bvid || args._[1]
  if (!bvid) die('缺少 --bvid')
  const count = Math.max(1, Math.min(12, Number(args.count) || 8))
  // 默认密集（1.2 帧/秒）；只有显式 --sparse 才抽几张单图
  const sparse = Boolean(args.sparse)
  // 默认只抽帧（约 16 秒）；识图用 `--vision-only` 分步跑。加 `--vision` 才在同一条命令里同步识图（很慢）。
  const vision = Boolean(args.vision) && process.env.BILI_VISION !== '0'
  const visionModel = args['vision-model'] || undefined
  // 帧率：--fps 0.63 / --fps 1.2 / --fps 120/100；不给就用 BILI_DENSE_FPS 或默认 6/5（1.2）
  const fps = args.fps !== undefined ? String(args.fps) : undefined
  // 去重：--dedupe 6 表示「相邻帧平均差 < 6 就丢后一帧」；不给就按 BILI_FRAME_DEDUPE（默认关）
  const dedupe = args.dedupe !== undefined ? Number(args.dedupe) : undefined
  // 默认不限张数（全量 1.2 帧/秒）；--max-sheets N 才封顶，0 = 不限
  const maxSheets = args['max-sheets'] !== undefined ? Number(args['max-sheets']) : undefined
  if (args.count !== undefined && !sparse) {
    console.log('提示：--count 只对 --sparse 生效；dense 模式默认不限张数，用 --max-sheets N 才封顶。')
  }
  cleanupFrames()
  const result = await extractFrames(bvid, { count, sparse, vision, visionModel, fps, dedupe, maxSheets })
  if (!result.ok) die(`抽帧失败：${result.message}`)
  try {
    writeRunMeta(result.dir, result)
    result.metaFile = path.join(result.dir, 'meta.json')
  } catch (error) {
    console.log(`元数据写入失败：${error.message}`)
  }
  if (!result.vision || !result.vision.length) {
    const count = result.sheets?.length || result.frames?.length || 0
    result.visionHint = `识图未跑：优先用 read_image 看这 ${count} 张图（想看几张看几张；没看清就说没看清）；需要本地 Qwen 对照再跑 frames --vision-only --bvid ${result.bvid}`
  }
  if (result.mode === 'dense') {
    const dropped = result.dropped ? `，去重跳过 ${result.dropped} 张` : ''
    const sampled = result.sampled
      ? `，原片 ${result.sampledFrom} 帧已全片均匀抽到 ${result.count} 帧`
      : `，原始 ${result.totalFrames || result.count} 张`
    console.log(
      `共 ${result.count} 帧（${result.fps} 帧/秒${sampled}${dropped}）→ ${result.sheets.length} 张联络表`,
    )
    for (const sheet of result.sheets) {
      console.log(`联络表 ${sheet.index}（${sheet.from}~${sheet.to}，${sheet.count} 格）  ${sheet.path}`)
    }
  } else {
    for (const frame of result.frames) console.log(`${frame.time}  ${frame.path}`)
  }
  if (result.vision && result.vision.length) {
    for (let i = 0; i < result.vision.length; i++) {
      const item = result.vision[i]
      const where =
        result.mode === 'dense'
          ? `表 ${result.sheets[i] ? result.sheets[i].index : i + 1}`
          : `${result.frames[i] ? result.frames[i].time : i + 1}`
      console.log(`本地识图 ${where}: ${item.ok ? item.text : '失败：' + item.message}`)
    }
  }
  if (result.visionError) console.log(`本地识图整体失败：${result.visionError}`)
  printResult(result)
}

async function cmdDynamic(args) {
  const sub = args._[0] || 'post'
  const text = args.text || ''
  if (sub === 'check') {
    if (!text) die('缺少 --text')
    const result = checkDynamicPrivacy(text)
    for (const warning of result.warnings) console.log(`⚠ ${warning}`)
    printResult({ ok: result.ok, ...result })
    return
  }
  if (sub === 'delete') {
    const id = args.id || args._[1]
    if (!id) die('缺少 --id <dynamicId>')
    const result = await deleteDynamic(id, { dryRun: Boolean(args['dry-run']) })
    if (!result.ok) die(`删动态失败：${result.message || result.code}`)
    console.log(result.dryRun ? `（dry-run）会删 ${id}` : `已删动态 ${id}`)
    printResult({ ok: true, ...result })
    return
  }
  if (!text) die('缺少 --text')
  return cmdLife({ ...args, _: ['action', 'dynamic'] })
}

// ── main ───────────────────────────────────────────────────────────────────

const HELP = `bili-lite — 刷 B 站推荐流，挑值得看的，把「标题+链接+一句话」发到自己的 B 站私信

用法：node src/cli.mjs <command> [options]

命令：
  login [--force]                    扫码登录（凭证只存本地 state/state.json）
  scan [--limit 20] [--enrich false] 刷推荐流、补详情/热评/字幕/弹幕、打分排序
  review                             打印候选摘要 + 生成「一句话」提示词
  pick --bvid BV... --verdict 值得看|可以看|不值当 --one-liner "..." [--review "..."]
  react [--yes]                     对今天 pick 的视频执行互动（点赞/私密收藏/关注/投币，按 config 开关）
  prompt review --bvid BV...        生成「给这条视频写点评」的提示词（写入 state/prompt-review.md）
  watch [--interval 60] [--timeout 14400]  监听私信，收到新消息就退出（实时回复用）
  watch --daemon [--interval 60]     常驻监听，新消息写入 state/inbox-pending.json（Windows 计划任务用）
  pending [--clear]                  查看/清空待处理私信队列（DSH 定时提醒消费）
  send [--yes] [--force]             dry-run 打印待发私信；config dryRun=false 且 --yes 才真发；--force 绕过每日额度
  inbox [--since <ts>]               查新私信（只回本人；分享链接会自动解析视频）
  reply --text "..." [--to uid] [--proactive]  回复私信；--proactive 表示她主动开口（计入每日 10 条技术上限）
  account                            查看当前账号资料（昵称/头像/uid）
  rename --name "新昵称"             修改 B 站昵称（有次数限制）
  avatar --file <图片>               上传并更换 B 站头像（jpg/png/webp）
  config [key=value ...]             查看/修改配置（dryRun / targetUid / dailyLimit / personaText / preferKeywords 等）
  diary [status|read|add|pack]       两本日记：公开（主人可看）/ 私密（只有她自己看）；pack 生成重置记忆包
  session [status|turn|reset]        会话切换：默认一天一个对话（阈值 0=关闭），首轮注入人设 + 两本日记
  mood [status|set|adjust|history|drift] 她的心情（五根轴 + 底色）；--adjust 带硬护栏；history 看曲线
  impressions [add|list|recall|pin]  她记住的东西：作者/题目/内容/评论/感觉，链接可选
  speech [recent|brief|check|profile] 她说过的话 + 语言习惯（防复读/照读日记/刷梗）
  comments [list|stats|file]         评论台账（只读历史；评论发送已停用）
  memory [stats|due|plan|consolidate] 每月整理：留 63%，其余遗忘；pinned/最近 7 天保护
  life [status|context|plan|prompt|finish|tick|action|recall|say] 她自己的生活：低谷期每两小时一件小事，可手动写计划
  dynamic post|check|delete --text "..." [--bvid] [--image]  文字/图片/视频分享动态（每天最多 3 条）
  frames --bvid BV... [--sparse] [--fps 0.63] [--max-sheets N] [--vision] [--vision-model qwen3-vl:8b]
                                     抽画面：默认 1.2 帧/秒（约 0.83 秒一格）拼 3×3 联络表，约 16 秒返回；默认张数不限；--max-sheets N 才封顶（0 = 不限）；--fps 改密度（0.63 = 63 帧/100 秒）；--sparse 才抽 1~12 张单图
  frames --vision-only [--bvid BV...|--dir <run>] [--limit 2]                 对已抽好的 run 补识图（2 张/次，<300s；重复跑到 remaining=0）
  frames --vision-status [--bvid BV...|--dir <run>]                          只读识图进度/已有文本（不跑模型）
  status                             登录态 / 配置 / 计数
  demo                               无登录端到端演示（本地报告 + 卡片墙）
  plan [--skip-chance 0.3]           规划今天几点跑：自动避开 DeepSeek 高峰，随机 5 分钟粒度
  guard                              判断现在是否 DeepSeek 高峰（定时任务先跑这个）
  wake [--skip 0.3]                  随机决定今天刷不刷（给定时任务用）
`

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const args = parseArgs(argv.slice(1))
  switch (command) {
    case 'login':
      return cmdLogin(args)
    case 'scan':
      return cmdScan(args)
    case 'review':
      return cmdReview(args)
    case 'pick':
      return cmdPick(args)
    case 'react':
      return cmdReact(args)
    case 'send':
      return cmdSend(args)
    case 'inbox':
      return cmdInbox(args)
    case 'reply':
      return cmdReply(args)
    case 'account':
      return cmdAccount(args)
    case 'prompt':
      return cmdPrompt(args)
    case 'watch':
      return cmdWatch(args)
    case 'pending':
      return cmdPending(args)
    case 'rename':
      return cmdRename(args)
    case 'avatar':
      return cmdAvatar(args)
    case 'config':
      return cmdConfig(args)
    case 'diary':
      return cmdDiary(args)
    case 'session':
      return cmdSession(args)
    case 'mood':
      return cmdMood(args)
    case 'impressions':
      return cmdImpressions(args)
    case 'speech':
      return cmdSpeech(args)
    case 'comments':
      return cmdComments(args)
    case 'memory':
      return cmdMemory(args)
    case 'life':
      return cmdLife(args)
    case 'dynamic':
      return cmdDynamic(args)
    case 'frames':
      return cmdFrames(args)
    case 'status':
      return cmdStatus(args)
    case 'demo':
      return cmdDemo(args)
    case 'plan':
      return cmdPlan(args)
    case 'guard':
      return cmdGuard(args)
    case 'wake':
      return cmdWake(args)
    case undefined:
    case '-h':
    case '--help':
    case 'help':
      console.log(HELP)
      return
    default:
      die(`未知命令 ${command}（用 --help 看帮助）`)
  }
}

main().catch((error) => {
  console.error(`未捕获错误：${error && error.stack ? error.stack : error}`)
  printResult({ ok: false, error: error && error.message ? error.message : String(error) })
  process.exit(1)
})
