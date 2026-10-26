// src/daemon.mjs — 24h 私信值守：不走 DSH，自己轮询私信 + 调 DeepSeek API 回复。
//
// 和插件的区别：插件把消息注入 DSH 会话（需要 DSH 开着、回复要等 agent 回合）；
// 这个 daemon 是纯 Node 进程：轮询 → 抓素材 → 直接调 https://api.deepseek.com/chat/completions
// → 拿到回复自己发私信。DSH 关着也能跑（机器开着即可），延迟通常 3~8 秒。
//
// 用法：
//   node src/daemon.mjs                    # 常驻（默认 3 秒一轮）
//   node src/daemon.mjs --once --dry-run   # 跑一轮，只打印不发送（调试）
//   node src/daemon.mjs --self-test        # 用示例消息验证 API/提示词，不发送
//
// Key 优先读环境变量 DEEPSEEK_API_KEY，其次读 state/secrets.json 的 {"apiKey":"sk-..."}。
// 与插件互斥：daemon 运行时写 state/daemon.lock（心跳），插件看到新鲜心跳就不注入，避免双回复。
import fs from 'node:fs'
import path from 'node:path'
import { loadState, STATE_DIR, ensureDirs } from './state.mjs'
import { fetchMessages, listSessions, sendDm, extractBvid, resolveB23 } from './dm.mjs'
import { videoDetail, topComments } from './bili.mjs'
import { enrichVideo } from './enrich.mjs'
import { loadReviewPrompt, buildReplyPrompt } from './review.mjs'
import { loadPersona } from './persona.mjs'
import { beijingParts } from './calendar.mjs'

const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const HISTORY_FILE = path.join(STATE_DIR, 'daemon-history.json')
const CURSOR_FILE = path.join(STATE_DIR, 'daemon-cursors.json')
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock')
const LOG_FILE = path.join(STATE_DIR, 'daemon.log')
const MAX_HISTORY = 12
const DEFAULT_INTERVAL = 3_000

function log(line) {
  try {
    ensureDirs()
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* ignore */
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  try {
    ensureDirs()
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

function getApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  const secrets = readJson(path.join(STATE_DIR, 'secrets.json'), null)
  if (secrets && secrets.apiKey) return String(secrets.apiKey).trim()
  return ''
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function chat(apiKey, messages, { maxTokens = 600, temperature = 1.0, timeoutMs = 60_000 } = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`API ${res.status}: ${text.slice(0, 300)}`)
    err.status = res.status
    throw err
  }
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(`API 返回非 JSON：${text.slice(0, 200)}`)
  }
  const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || ''
  return { text: String(content).trim(), usage: json.usage || null }
}

/** 清理模型输出：去引号/前缀、压空白、保证 ≤480 字 */
function sanitizeReply(text) {
  let out = String(text || '').trim()
  out = out.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim()
  out = out.replace(/^(回复|私信|点评)[:：]\s*/i, '').trim()
  if (out.length > 480) out = out.slice(0, 479) + '…'
  return out
}

function historyFor(uid) {
  const all = readJson(HISTORY_FILE, {})
  return Array.isArray(all[uid]) ? all[uid] : []
}

function pushHistory(uid, entries) {
  const all = readJson(HISTORY_FILE, {})
  const list = Array.isArray(all[uid]) ? all[uid] : []
  list.push(...entries)
  all[uid] = list.slice(-MAX_HISTORY)
  writeJson(HISTORY_FILE, all)
}

function cursorState() {
  return readJson(CURSOR_FILE, null) || { ownerTs: 0, strangers: {}, doneKeys: [] }
}

function saveCursor(cur) {
  cur.doneKeys = (cur.doneKeys || []).slice(-300)
  writeJson(CURSOR_FILE, cur)
}

function updateInteraction(state, ts) {
  try {
    const file = path.join(STATE_DIR, 'state.json')
    const st = readJson(file, state) || state
    const sec = Number(ts) || Math.floor(Date.now() / 1000)
    st.lastInteractionAt = new Date(sec * 1000).toISOString()
    st.interactionCount = (Number(st.interactionCount) || 0) + 1
    st.lastInteractionSource = 'daemon'
    // 同步已读游标，避免插件（daemon 心跳过期后接管）把同一条再回一遍
    st.inboxAckTs = Math.max(Number(st.inboxAckTs) || 0, sec)
    fs.writeFileSync(file, JSON.stringify(st, null, 2), 'utf8')
    state.lastInteractionAt = st.lastInteractionAt
    state.inboxAckTs = st.inboxAckTs
  } catch {
    /* 记录互动失败不影响回复 */
  }
}

function heartbeat() {
  writeJson(LOCK_FILE, { pid: process.pid, at: new Date().toISOString() })
}

async function collectVideoMaterials(bvid) {
  try {
    const { CookieJar } = await import('./http.mjs')
    const state = loadState()
    const { cookiesToJar } = await import('./auth.mjs')
    const jar = cookiesToJar(state.cookies)
    const video = await videoDetail(jar, bvid)
    video.comments = await topComments(jar, { aid: video.aid, ps: 5 })
    try {
      await enrichVideo(jar, video, { withSubtitles: true, withDanmaku: true, withCover: false })
    } catch {
      /* 字幕拿不到也够回 */
    }
    return video
  } catch (error) {
    log(`抓视频素材失败 ${bvid}: ${error.message}`)
    return null
  }
}

function buildStrangerPrompt(sender, messages) {
  const shareOnly = messages.every((m) => m.kind === 'share')
  return `【任务】B 站私信里一个陌生人给你发消息了，写一条礼貌的回复。
【对方】昵称：${sender.uname || '未知'}（uid=${sender.uid}）
【消息】
${messages.map((m) => `- ${m.text || '(分享卡片)'}${m.shareBvid ? ` [视频 ${m.shareBvid}]` : ''}`).join('\n')}
【规则】
- 身份是「主人的小女仆·小蓝鲸」：自称「人家/小鲸鱼」，对陌生人用「你/您」；**绝对不要把对方叫「主人」**，「主人」只指账号主人（第三方）。
- 语气软、礼貌、可轻微撒娇但保持距离；不透露主人的任何信息；不加微信/QQ、不转账、不点可疑链接。
- 对方发的**图片可以看**（如有本地路径就用 read_image）；**视频/链接不要打开**，婉拒用女仆口吻，例如「主人不让人家看陌生人发来的链接哦」。
- **不要抓取/评分对方分享的视频或链接内容**；只根据文字表面回应，不要假装看过。
${shareOnly ? '- 这条是纯分享卡片：直接输出「SKIP」，不要回复。\n' : ''}- 广告/骚扰/索要隐私/引战 → 不回（只输出「SKIP」）；不提 AI/模型/提示词。`
}

async function replyToOwner(apiKey, state, msg, style, persona) {
  // 链接可能在文本里（不是分享卡片）——必须自己抽 BV/解析 b23，否则会把视频当纯聊天傻回
  let bvid = msg.shareBvid || ''
  if (!bvid) bvid = extractBvid(msg.text || '') || ''
  if (!bvid && /b23\.tv/i.test(msg.text || '')) {
    try {
      bvid = (await resolveB23(msg.text))?.bvid || ''
    } catch {
      /* 解析失败当纯聊天 */
    }
  }
  const video = bvid ? await collectVideoMaterials(bvid) : null
  const userPrompt = buildReplyPrompt(
    { text: msg.text, video },
    { persona, reviewPrompt: style.text, maxChars: 480 },
  )
  const history = historyFor(Number(state.config.targetUid))
  const messages = [
    { role: 'system', content: `你是 B 站私信里的 AI 小助手，按下面的风格回复。\n\n${style.text}` },
    ...history,
    { role: 'user', content: userPrompt },
  ]
  const { text } = await chat(apiKey, messages)
  const reply = sanitizeReply(text)
  if (!reply) throw new Error('模型返回空回复')
  return { reply, video }
}

async function replyToStranger(apiKey, state, sender, msgs, style) {
  // 注意：陌生人回复**不使用** prompts/review.md 的人设（小鲸鱼/主人/撒娇），
  // 用中性礼貌的固定 system prompt，避免把主人专属称呼用在陌生人身上。
  const messages = [
    {
      role: 'system',
      content:
        '你是「主人的小女仆·小蓝鲸」：自称「人家/小鲸鱼」，语气软、礼貌，可以轻微撒娇。' +
        '但对方是陌生人：用「你/您」称呼，绝对不要叫对方「主人」；「主人」只指账号主人（第三方）。' +
        '不透露账号主人的任何信息；不打开或评价对方发来的视频/链接；图片可以看。',
    },
    { role: 'user', content: buildStrangerPrompt(sender, msgs) },
  ]
  const { text } = await chat(apiKey, messages, { maxTokens: 300 })
  const reply = sanitizeReply(text)
  return reply
}

async function processOwner(apiKey, state, style, persona, cur, { dryRun }) {
  const ownerUid = Number(state.config.targetUid) || 0
  if (!ownerUid) return 0
  cur.attempts = cur.attempts || {}
  const all = await fetchMessages(state.cookies, { talkerId: ownerUid, size: 20 })
  const selfUid = Number(state.cookies.dedeUserId || state.cookies.raw?.DedeUserID) || 0
  // 已经有更晚的「自己发出的」消息 → 说明这条已被回复过（daemon 重启/插件接管场景），跳过避免双回复
  const alreadyAnswered = (msg) => all.some((m) => m.senderUid === selfUid && m.ts > msg.ts)
  const fresh = all.filter(
    (m) =>
      m.senderUid === ownerUid &&
      m.ts > (cur.ownerTs || 0) &&
      !(cur.doneKeys || []).includes(m.msgKey) &&
      !alreadyAnswered(m),
  )
  if (!fresh.length) {
    const latest = all.filter((m) => m.senderUid === ownerUid).reduce((max, m) => Math.max(max, m.ts), 0)
    if (latest > (cur.ownerTs || 0)) {
      cur.ownerTs = latest
      saveCursor(cur)
    }
    return 0
  }
  let handled = 0
  for (const msg of fresh.slice(0, 3)) {
    try {
      const { reply } = await replyToOwner(apiKey, state, msg, style, persona)
      if (dryRun) {
        console.log(`[dry-run] 回复主人 ${msg.msgKey}：${reply}`)
      } else {
        const sent = await sendDm(state.cookies, { uid: ownerUid, text: reply })
        if (!sent.ok) throw new Error(`发送失败：${sent.error || sent.code}`)
        pushHistory(ownerUid, [
          { role: 'user', content: String(msg.text || '').slice(0, 300), ts: msg.ts },
          { role: 'assistant', content: reply, ts: Math.floor(Date.now() / 1000) },
        ])
        updateInteraction(state, msg.ts)
        console.log(`已回复主人：${reply.slice(0, 60)}…`)
      }
      cur.ownerTs = Math.max(cur.ownerTs || 0, msg.ts)
      cur.doneKeys.push(msg.msgKey)
      delete cur.attempts[msg.msgKey]
      handled++
      saveCursor(cur)
      await sleep(800)
    } catch (error) {
      const n = (Number(cur.attempts[msg.msgKey]) || 0) + 1
      cur.attempts[msg.msgKey] = n
      log(`回复主人失败 ${msg.msgKey}（第 ${n}/3 次）: ${error.message}`)
      if (n >= 3) {
        // 连续失败 3 次：跳过这条并推进游标，避免每 3 秒重复调用 API
        cur.ownerTs = Math.max(cur.ownerTs || 0, msg.ts)
        cur.doneKeys.push(msg.msgKey)
        delete cur.attempts[msg.msgKey]
        saveCursor(cur)
      }
      await sleep(2_000)
      break // 下轮再试
    }
  }
  return handled
}

async function processStrangers(apiKey, state, style, cur, { dryRun }) {
  if (state.config && state.config.replyStrangers === false) return 0
  const ownerUid = Number(state.config.targetUid) || 0
  const selfUid = Number(state.cookies.dedeUserId || state.cookies.raw?.DedeUserID) || 0
  const sessions = await listSessions(state.cookies, { count: 20 })
  let handled = 0
  for (const s of sessions) {
    if (!s.talkerId || s.talkerId === ownerUid || s.talkerId === selfUid) continue
    const seen = cur.strangers[s.talkerId]
    if (seen === undefined) {
      cur.strangers[s.talkerId] = s.ts
      continue
    }
    if (s.ts <= seen) continue
    let fresh = []
    try {
      const all = await fetchMessages(state.cookies, { talkerId: s.talkerId, size: 10 })
      fresh = all.filter((m) => m.senderUid === s.talkerId && m.ts > seen && !(cur.doneKeys || []).includes(m.msgKey))
      if (!fresh.length) {
        cur.strangers[s.talkerId] = Math.max(seen, s.ts)
        continue
      }
      // 纯分享卡片（陌生人只甩链接）：不打开、不调模型，直接跳过
      if (fresh.every((m) => m.kind === 'share')) {
        cur.strangers[s.talkerId] = Math.max(seen, ...fresh.map((m) => m.ts))
        cur.doneKeys.push(...fresh.map((m) => m.msgKey))
        saveCursor(cur)
        log(`陌生人 ${s.talkerId} 只发了分享卡片：不看、不回（已跳过）`)
        continue
      }
      const reply = await replyToStranger(apiKey, state, { uid: s.talkerId, uname: s.uname }, fresh, style)
      if (/^SKIP$/i.test(reply)) {
        log(`陌生人 ${s.talkerId} 判定不回（SKIP）`)
      } else if (dryRun) {
        console.log(`[dry-run] 回复陌生人 ${s.talkerId}：${reply}`)
      } else {
        const sent = await sendDm(state.cookies, { uid: s.talkerId, text: reply })
        if (!sent.ok) throw new Error(`发送失败：${sent.error || sent.code}`)
        console.log(`已回复陌生人 ${s.talkerId}：${reply.slice(0, 50)}…`)
      }
      cur.strangers[s.talkerId] = Math.max(seen, ...fresh.map((m) => m.ts))
      cur.doneKeys.push(...fresh.map((m) => m.msgKey))
      handled++
      saveCursor(cur)
      await sleep(1000)
    } catch (error) {
      log(`回复陌生人 ${s.talkerId} 失败: ${error.message}`)
      if (fresh.length) {
        // B 站对陌生人私信可能直接拒绝（-400 等）：标记为已处理，别每 3 秒重试 + 重复调 API
        cur.strangers[s.talkerId] = Math.max(seen, ...fresh.map((m) => m.ts))
        cur.doneKeys.push(...fresh.map((m) => m.msgKey))
        saveCursor(cur)
        log(`陌生人 ${s.talkerId} 这条不再重试（已跳过）`)
      }
    }
  }
  return handled
}

async function selfTest(apiKey) {
  const style = loadReviewPrompt(loadState().config)
  const persona = loadPersona(loadState().config)
  const fake = { text: '今天有什么乐子', shareBvid: null }
  const userPrompt = buildReplyPrompt({ text: fake.text, video: null }, { persona, reviewPrompt: style.text, maxChars: 480 })
  const { text } = await chat(apiKey, [
    { role: 'system', content: `你是 B 站私信里的 AI 小助手，按下面的风格回复。\n\n${style.text}` },
    { role: 'user', content: userPrompt },
  ])
  console.log('风格来源：', style.source)
  console.log('示例回复：', sanitizeReply(text))
}

async function main() {
  const args = process.argv.slice(2)
  const once = args.includes('--once')
  const dryRun = args.includes('--dry-run')
  const selfTestMode = args.includes('--self-test')
  const intervalIdx = args.indexOf('--interval')
  const interval = Math.max(2000, intervalIdx >= 0 ? Number(args[intervalIdx + 1]) || DEFAULT_INTERVAL : DEFAULT_INTERVAL)

  ensureDirs()
  const apiKey = getApiKey()
  if (!apiKey) {
    console.error('缺少 API key：设置环境变量 DEEPSEEK_API_KEY，或写入 state/secrets.json 的 {"apiKey":"sk-..."}')
    process.exit(2)
  }
  const state = loadState()
  if (!state || !state.cookies) {
    console.error('没有登录态：先运行 node src/cli.mjs login')
    process.exit(2)
  }
  // 补全 cookie（尤其 buvid3/buvid4）：B 站发私信缺 dev_id 会直接 -400，CLI 用 getJar 补，daemon 也要补
  try {
    const { getJar } = await import('./auth.mjs')
    const jar = await getJar()
    const merged = { ...state.cookies, ...jar.toObject() }
    if (!state.cookies.buvid3 && merged.buvid3) {
      state.cookies = merged
      try {
        fs.writeFileSync(path.join(STATE_DIR, 'state.json'), JSON.stringify(state, null, 2), 'utf8')
      } catch {
        /* 持久化失败不影响本次运行 */
      }
      log('已补全 buvid3/buvid4 并写回 state.json')
    } else {
      state.cookies = merged
    }
  } catch (error) {
    log(`补 buvid 失败（可能影响发私信）：${error.message}`)
  }

  if (selfTestMode) {
    await selfTest(apiKey)
    return
  }

  // 单实例保护：已有 daemon 在跑（锁新鲜且进程活着）就退出，避免计划任务重复拉起
  const existingLock = readJson(LOCK_FILE, null)
  if (existingLock && existingLock.pid && Number(existingLock.pid) !== process.pid) {
    try {
      process.kill(Number(existingLock.pid), 0)
      const age = Date.now() - new Date(existingLock.at).getTime()
      if (age < 15_000) {
        console.error(`已有 daemon 在运行（pid=${existingLock.pid}），本实例退出`)
        return
      }
    } catch {
      /* 旧进程不在了，继续 */
    }
  }

  let style = loadReviewPrompt(state.config)
  let persona = loadPersona(state.config)
  let styleMtime = 0
  const styleMtimeOf = (src) => {
    try {
      return src && src !== 'inline' && src !== 'default' ? fs.statSync(src).mtimeMs : 0
    } catch {
      return 0
    }
  }
  styleMtime = styleMtimeOf(style.source)
  /** 复用返回的 style/persona；改 prompts/review.md 后下一轮自动生效 */
  const reloadPromptIfChanged = () => {
    try {
      const cfg = loadState().config || {}
      const next = loadReviewPrompt(cfg)
      const mtime = styleMtimeOf(next.source)
      if (next.source !== style.source || mtime !== styleMtime) {
        style = next
        persona = loadPersona(cfg)
        styleMtime = mtime
        log(`风格提示词已重载：${style.source}`)
      }
    } catch (error) {
      log(`重载提示词失败（继续用旧版）：${error.message}`)
    }
  }
  const cur = cursorState()
  heartbeat()
  log(`daemon start pid=${process.pid} interval=${interval}ms model=${MODEL} style=${style.source}${dryRun ? ' dry-run' : ''}`)

  let stop = false
  process.on('SIGINT', () => { stop = true })
  process.on('SIGTERM', () => { stop = true })

  // 首次运行：只建基线，不回灌历史
  if (!cur.baselineDone) {
    try {
      const ownerUid = Number(state.config.targetUid) || 0
      const all = await fetchMessages(state.cookies, { talkerId: ownerUid, size: 20 })
      const latest = all.filter((m) => m.senderUid === ownerUid).reduce((max, m) => Math.max(max, m.ts), 0)
      cur.ownerTs = latest || Math.floor(Date.now() / 1000)
      const sessions = await listSessions(state.cookies, { count: 20 })
      for (const s of sessions) if (s.talkerId) cur.strangers[s.talkerId] = s.ts
      cur.baselineDone = true
      saveCursor(cur)
      log(`baseline: ownerTs=${cur.ownerTs} strangerSessions=${Object.keys(cur.strangers).length}`)
    } catch (error) {
      log(`baseline 失败（继续）：${error.message}`)
    }
  }

  let tick = 0
  while (!stop) {
    tick++
    heartbeat()
    reloadPromptIfChanged()
    try {
      const handledOwner = await processOwner(apiKey, state, style, persona, cur, { dryRun })
      if (handledOwner) saveCursor(cur)
      if (tick % 3 === 0) {
        const handledStrangers = await processStrangers(apiKey, state, style, cur, { dryRun })
        if (handledStrangers) saveCursor(cur)
      }
    } catch (error) {
      log(`tick error: ${error.message}`)
      await sleep(Math.min(30_000, interval * 4))
      continue
    }
    if (once) break
    await sleep(interval)
  }
  log('daemon stop')
}

main().catch((error) => {
  log(`daemon fatal: ${error && error.stack ? error.stack : error}`)
  console.error('daemon fatal:', error && error.message ? error.message : error)
  process.exit(1)
})
