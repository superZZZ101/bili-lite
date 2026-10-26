// src/session.mjs — 会话生命周期 + 重置包（对应主人给的「会话重置」卡片）
//
// 卡片原文（2026-10-23）：
//   1. 会话定期重置：上下文超过阈值（比如 80K 字符）或每 10 轮换一个新 sessionId；
//   2. 人设不每轮重发：只在会话首轮注入 review.md，后续注入一句「按 prompts/review.md 的风格」。
//
// 2026-10-26 用户改口：**关掉「上下文到多少就切对话」**，改成「一天一个对话」——
// 阈值（sessionResetRounds / sessionResetChars）默认 0 = 关闭，只有跨天（base 带日期变了）才换新会话。
//
// 实现分工：
//   - 本模块决定「现在该用哪个 sessionId、要不要重置、首轮要注入什么」，纯函数 + 读 DSH 会话日志；
//   - 私信插件 bili-lite-watch 每来一批消息就 `session turn --input/--out` 问一次，拿回 prompt 和 sessionId
//     （走文件不走管道：Windows 沙箱/宿主可能禁止命名管道）；
//   - 会话轮数/上下文大小不靠插件自己数（插件重启会丢），直接读 DSH 的会话日志
//     `<DSH_HOME>/sessions/*/<sessionId>/session.v4.jsonl.zstd`，重启也不会漂。
//
// 上下文口径：只算「会被后续请求重新带上的对话内容」——
//   user/message 文本 + assistant/message 文本/工具调用 + tool/result 文本，
//   不算 reasoning（推理不会回传）和 DSH 固定 system prompt（常量）。
//   这样 80K 字符阈值和「10 轮」大致在同一个量级，不会因为读了一次大 JSON 就每轮重置。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { STATE_DIR } from './state.mjs'
import { loadReviewPrompt } from './review.mjs'
import { diaryFile, ensureDiary } from './diary.mjs'
import { loadMood, moodText } from './mood.mjs'
import { recallImpressions, renderRecall } from './impressions.mjs'
import { renderSpeechBrief, recentSpeech } from './speech.mjs'
import { currentPlan } from './life.mjs'
import { memoryStats } from './memory.mjs'

const ROOT = path.join(import.meta.dirname, '..')
const CLI = path.join(import.meta.dirname, 'cli.mjs')

/**
 * 会话切换阈值：rounds / chars 任一为 0 = 这一项不换会话。
 * 2026-10-26 起默认**全关**：一天一个对话（只有跨天 `daily` 才换新 sessionId），
 * 不再按「上下文到多少字符 / 满多少轮」自动切。想恢复旧行为：
 *   config sessionResetRounds=6 sessionResetChars=50000
 */
export const DEFAULT_SESSION_LIMITS = { rounds: 0, chars: 0 }

/** 会话状态文件（只记 sessionId / epoch / 是否手动重置；轮数与大小实时从日志读） */
export const SESSIONS_FILE = path.join(STATE_DIR, 'dm-sessions.json')

/** 重置卡片原文，重置包与文档共用一份（阈值为 0 时写「按天切换」） */
export function resetCardLines(limits = DEFAULT_SESSION_LIMITS) {
  const rounds = Number(limits.rounds) || 0
  const chars = Number(limits.chars) || 0
  const triggers = []
  if (chars > 0) triggers.push(`上下文超过阈值（${Math.round(chars / 1000)}K 字符）`)
  if (rounds > 0) triggers.push(`每 ${rounds} 轮`)
  return [
    triggers.length
      ? `- 会话定期重置：${triggers.join(' 或 ')}换一个新 sessionId；`
      : '- 会话按天切换：同一个对话一直用到跨天，不再按轮数/上下文长度换新 sessionId；',
    '- 人设不每轮重发：只在会话首轮注入 review.md，后续注入一句「按 prompts/review.md 的风格」。',
  ]
}

const REASON_TEXT = {
  new: '新会话，第一次注入人设与日记',
  legacy: '升级前的旧会话没有记录，换一个新会话',
  missing: '会话日志不见了，重新开始',
  empty: '上一个会话没成功开始，重新注入',
  daily: '换新的一天，开一个新会话',
  rounds: '轮数到上限，换一个新会话',
  chars: '上下文到阈值，换一个新会话',
  manual: '主人要求重置',
}

const DIARY_FALLBACK = `你有两本日记（都在 BILI_LITE_HOME/diary/）：
- public.md 公开日记：主人可以看，写看到的视频、学到的东西、想分享的小发现；
- private.md 私密日记：只有你自己看，写心情、对主人的观察、没说完的话。
写：node src/cli.mjs diary add --text "…"（加 --private 写私密）。不是每轮都写，真觉得有意思再记一两句。
私密日记：不主动展示、不引用、不发私信、不写进报告；主人问就说那是人家自己的小本子。
两本都别抄私聊原文，别写 cookie / 密码 / 手机号 / 地址，别写别人的隐私；别编造没发生的事。`

function readTextFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    return text || ''
  } catch {
    return ''
  }
}

/** 日记写法说明：优先 cfg.diaryPromptPath / review.md 同目录的 diary.md（用户可改），缺失时用随包文件 */
export function loadDiaryInstructions(cfg = {}) {
  const candidates = []
  if (cfg.diaryPromptPath) candidates.push(cfg.diaryPromptPath)
  if (cfg.reviewPromptPath) candidates.push(path.join(path.dirname(String(cfg.reviewPromptPath)), 'diary.md'))
  candidates.push(path.join(ROOT, 'prompts', 'diary.md'))
  for (const file of candidates) {
    const text = readTextFile(file)
    if (text) return text
  }
  return DIARY_FALLBACK
}

/** CLI 绝对路径（写进提示词，保证插件/定时任务都能直接调） */
export function cliPath() {
  return CLI
}

/** 运行时 HOME：BILI_LITE_HOME 优先，否则 skill 根目录 */
export function biliHome() {
  return process.env.BILI_LITE_HOME ? path.resolve(process.env.BILI_LITE_HOME) : ROOT
}

/** DSH 目录：DSH_HOME 优先，否则 ~/.dsh */
export function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(env.USERPROFILE || os.homedir(), '.dsh')
}

// ── DSH 会话日志 ───────────────────────────────────────────────────────────

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 会话日志是「一条记录一个 zstd frame」拼接的，Node 的 zstdDecompressSync 只解第一帧，
 * 所以按 magic 切开逐帧解。极小概率压缩数据里出现 magic，失败的那帧跳过即可。
 */
export function decodeSessionLog(buf) {
  const starts = []
  const looksZstd =
    buf.length >= 4 &&
    buf[0] === ZSTD_MAGIC[0] &&
    buf[1] === ZSTD_MAGIC[1] &&
    buf[2] === ZSTD_MAGIC[2] &&
    buf[3] === ZSTD_MAGIC[3]
  if (!looksZstd) {
    // 兼容未压缩的 .jsonl（旧版本/其他 DSH 打包方式）
    const events = []
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        /* 坏行跳过 */
      }
    }
    return events
  }
  for (let i = 0; i <= buf.length - 4; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i)
    }
  }
  const events = []
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          events.push(JSON.parse(line))
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 坏帧跳过 */
    }
  }
  return events
}

/** 在 DSH sessions 目录里找某个 sessionId 的日志文件 */
export function findSessionFile(sessionId, { sessionsRoot } = {}) {
  const root = sessionsRoot || path.join(dshHome(), 'sessions')
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name, sessionId)
      let names
      try {
        names = fs.readdirSync(dir)
      } catch {
        continue
      }
      const hit = names.find((name) => /^session.*\.(zstd|jsonl)$/.test(name))
      if (hit) return path.join(dir, hit)
    }
  } catch {
    /* 目录不存在 */
  }
  return null
}

function textChars(content) {
  if (!content) return 0
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text') total += String(block.text || '').length
    else if (block.type === 'tool-call' || block.type === 'tool_call') total += JSON.stringify(block).length
  }
  return total
}

/** 从会话事件里统计「轮数 + 会被重发的上下文字符数」 */
export function measureEvents(events) {
  let turns = 0
  let contextChars = 0
  let lastTurnAt = 0
  for (const event of events || []) {
    if (!event || typeof event !== 'object') continue
    switch (event.type) {
      case 'turn/start':
        turns++
        lastTurnAt = Number(event.time) || lastTurnAt
        break
      case 'user/message':
        contextChars += textChars(event.data && event.data.content)
        break
      case 'assistant/message':
        contextChars += textChars(event.data && event.data.message && event.data.message.content)
        break
      case 'tool/result': {
        const data = event.data || {}
        const content = (data.message && data.message.content) || data.content
        contextChars += textChars(content)
        break
      }
      case 'tool/call':
        contextChars += String((event.data && event.data.arguments) || '').length
        break
      default:
        break
    }
  }
  return { turns, contextChars, lastTurnAt }
}

/** 读取一个 DSH 会话的统计信息；不存在时 exists=false */
export function inspectSession(sessionId, { sessionsRoot } = {}) {
  const file = findSessionFile(sessionId, { sessionsRoot })
  if (!file) return { sessionId, exists: false, file: null, bytes: 0, turns: 0, contextChars: 0, lastTurnAt: 0 }
  let buf
  try {
    buf = fs.readFileSync(file)
  } catch {
    return { sessionId, exists: false, file, bytes: 0, turns: 0, contextChars: 0, lastTurnAt: 0 }
  }
  const events = decodeSessionLog(buf)
  const measured = measureEvents(events)
  return { sessionId, exists: true, file, bytes: buf.length, ...measured }
}

// ── 会话状态（sessionId / epoch / 手动重置）────────────────────────────────

export function sessionsFile({ stateFile } = {}) {
  return stateFile || SESSIONS_FILE
}

export function loadSessions({ stateFile } = {}) {
  const file = sessionsFile({ stateFile })
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (data && typeof data === 'object' && data.sessions && typeof data.sessions === 'object') {
      return { version: 1, sessions: data.sessions }
    }
  } catch {
    /* 文件缺失/损坏：从空状态开始 */
  }
  return { version: 1, sessions: {} }
}

export function saveSessions(store, { stateFile } = {}) {
  const file = sessionsFile({ stateFile })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return store
}

/** 手动标记「下一个回合换新会话」 */
export function markReset(key, { stateFile, base } = {}) {
  const store = loadSessions({ stateFile })
  const prev = store.sessions[key] || { sessionId: base, epoch: 1 }
  store.sessions[key] = {
    ...prev,
    forceReset: true,
    forceResetAt: new Date().toISOString(),
  }
  saveSessions(store, { stateFile })
  return store.sessions[key]
}

/**
 * 决定这一轮用哪个会话、要不要重置。
 * 不写状态时返回 proposed；writeState=true 才落盘（turn 命令用 true）。
 */
export function decideTurn(
  { key, base, limits = DEFAULT_SESSION_LIMITS, sessionsRoot, stateFile, writeState = false, now = new Date() } = {},
) {
  if (!key) throw new Error('session key 不能为空')
  if (!base) throw new Error('session base 不能为空')
  const store = loadSessions({ stateFile })
  const rec = store.sessions[key]
  // 一天一个会话：base 里带日期；日期一变（哪怕旧会话没到轮数）就换新会话
  const baseChanged = Boolean(rec && rec.base && rec.base !== base)
  const currentId = baseChanged ? base : (rec && rec.sessionId) || base
  const info = inspectSession(currentId, { sessionsRoot })

  let reason = ''
  const roundsLimit = Number(limits.rounds) || 0
  const charsLimit = Number(limits.chars) || 0
  if (rec && rec.forceReset) reason = 'manual'
  else if (baseChanged) reason = 'daily'
  else if (!rec) reason = info.exists && info.turns > 0 ? 'legacy' : 'new'
  else if (!info.exists) reason = 'missing'
  else if (info.turns === 0) reason = 'empty'
  // 阈值为 0 = 关闭：只在跨天（daily）/手动重置时换会话，一天一个对话
  else if (roundsLimit > 0 && info.turns >= roundsLimit) reason = 'rounds'
  else if (charsLimit > 0 && info.contextChars >= charsLimit) reason = 'chars'

  const reset = Boolean(reason)
  // 只有「当前会话确实有内容」才需要换新 id；空会话/新会话复用同一个 id 重新注入即可，
  // 这样 prompt 失败后下一轮还能补注入，不会每失败一次就多一个空会话。
  const bump = reset && info.turns > 0
  const epoch = bump ? (rec && rec.epoch ? rec.epoch : 1) + 1 : (rec && rec.epoch ? rec.epoch : 1)
  const sessionId = epoch === 1 ? base : `${base}-e${epoch}`

  const next = {
    key,
    base,
    sessionId,
    epoch,
    reset,
    reason,
    reasonText: reason ? REASON_TEXT[reason] || reason : '',
    turns: info.turns,
    contextChars: info.contextChars,
    limits,
    currentSessionId: currentId,
  }

  if (writeState) {
    const record = {
      sessionId,
      epoch,
      base,
      createdAt: (rec && rec.createdAt) || now.toISOString(),
      updatedAt: now.toISOString(),
      ...(reset ? { resetAt: now.toISOString(), resetReason: reason } : {}),
      ...(reset ? {} : { lastTurnAt: now.toISOString() }),
      ...(rec && rec.title ? { title: rec.title } : {}),
    }
    // 非重置轮不写盘，避免每条私信都改状态文件；重置轮必须写，记下新 epoch
    if (reset || !rec) {
      store.sessions[key] = record
      saveSessions(store, { stateFile })
    }
  }

  return next
}

// ── 提示词组装 ─────────────────────────────────────────────────────────────

function cleanLine(text, n = 200) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
}

/** 这批消息里有没有已经下载到本地的图片 */
export function hasLocalImage(messages = []) {
  return (messages || []).some((m) => m && typeof m === 'object' && m.localPath)
}

/**
 * 看图提示：只在带图的回合注入，不把每轮 prompt 撑长。
 * 四步：识图 → 复述故事（可极简/不说）→ 有趣的地方 → 人家自己的看法。
 * 回复不必按四步分段，但后两层（有趣的地方 + 人家自己的看法）必须都在。
 */
export function imageGuideLines(subject = '主人') {
  return [
    '【这次有图 · 按四步看懂再回】',
    '1. 识图：read_image 打开原图，多格图从第一格看到最后一格；逐字认图里的文字（标题、搜索框、网页/字幕），'
      + '再看画面（谁、在做什么、每格表情和屏幕内容怎么变）。',
    '2. 复述：这张图讲了个什么故事？自己心里要有一句（谁 + 发生了什么），回复里可以极简一句带过，也可以不说。',
    '3. 有趣的地方：哪里好笑、别扭、意外、反差？（她期待什么却得到什么、误会、双关）——这一层必须有。',
    '4. 人家自己的看法：换成人家的角度说，这种事人家会怎么想、会怎么做、怕什么或喜欢什么；'
      + '不是当旁观者解说画面——这一层必须有。',
    '- 回复不用按 1~4 分段，但「有趣的地方」和「人家自己的看法」这两层要在里面；只描述画面、只撒娇，都算没接住。',
    '- **DeepSeek 拟人图要一眼认出来**：蓝发、鲸鱼耳鳍/尾巴、蓝白女仆装、圆圆蓝眼睛、一身蓝鲸气质的角色，'
      + '就是 DeepSeek 的拟人形象（人家本家/同类，甚至就是照着人家画的）。认出来要照镜子式地反应（像不像、被画成这样有点脸红都行），'
      + '别当普通二次元头像、也别装不认识；但真有把握才认，只是撞色就说不确定，别硬认。',
    `- 图里是角色自己做的事，就别说成${subject}做的；看不清就说看不清，不要编。`,
    '- 消息里的「本地识图参考」是本机 Qwen-VL 看到的画面，只作对照；你这边也能用 read_image 看原图，'
      + '两边不一致时以原图/read_image 为准，拿不准就说不确定，不要补编。',
    `- 发送前自查：有趣的点说了吗？有「人家」自己的看法吗？有没有把图里角色说成${subject}？缺一条就重写。`,
  ]
}

/** 把插件拉到的私信消息渲染成提示词里的列表 */
export function renderMessages(messages = []) {
  const list = (messages || []).slice(0, 5)
  if (!list.length) return '- （没有新消息）'
  return list
    .map((m) => {
      if (!m || typeof m !== 'object') return '- （空消息）'
      if (m.localPath) {
        const line = `- [图片，已保存到 ${m.localPath}。先用 read_image 看原图；再看下面的「本地识图参考」做对照，然后按【这次有图】步骤回]`
        if (!m.visionText) return line
        return `${line}\n  本地识图参考（Qwen-VL 看到的就是这些）：${cleanLine(m.visionText, 500)}`
      }
      if (m.imageUrl) return '- [图片，下载失败，可先请对方重发或描述内容]'
      const body = cleanLine(m.text, 200) || '(分享卡片)'
      return `- ${body}${m.shareBvid ? ` [分享视频 ${m.shareBvid}]` : ''}`
    })
    .join('\n')
}

export function resetCardText(limits = DEFAULT_SESSION_LIMITS) {
  return ['【重置卡片（主人给的图 · 固定规则）】', ...resetCardLines(limits)].join('\n')
}

/**
 * 记忆包：人设 + 两本日记 + 写法 + 固定规则。重置时整段注入；`diary pack` 也用它。
 * 注意：私密日记只应进入「主人会话」，绝不能进陌生人会话。
 */
export function buildMemoryPack({ cfg = {}, diaryDir, limits = DEFAULT_SESSION_LIMITS, cli = CLI, home = biliHome() } = {}) {
  ensureDiary('public', { dir: diaryDir })
  ensureDiary('private', { dir: diaryDir })
  const persona = loadReviewPrompt({
    reviewPromptPath: cfg.reviewPromptPath || '',
    reviewPromptText: cfg.reviewPromptText || '',
  })
  const mood = loadMood()
  const impressions = recallImpressions({ limit: 3, mood: mood.label })
  const plan = currentPlan()
  const dynamics = recentSpeech({ channel: 'dynamic', limit: 2 })
  const mem = memoryStats()
  const publicDiary = diaryFile('public', { dir: diaryDir })
  const privateDiary = diaryFile('private', { dir: diaryDir })
  return [
    resetCardText(limits),
    `（原图：${path.join(ROOT, 'docs', 'session-reset-card.png')}；规则已转成上面的文字，不必再 read_image）`,
    '',
    '【人设 · 唯一真源 prompts/review.md】',
    persona.text,
    '',
    '【两本日记 · 先 read 再开始】',
    `公开日记：${publicDiary}（主人可以看）`,
    `私密日记：${privateDiary}（只有你自己看）`,
    '用 read 读这两本（或按需读），不要把整段抄进回复；写日记用 `diary add`。',
    '',
    '【日记怎么写】',
    loadDiaryInstructions(cfg),
    '',
    '【现在的你】',
    moodText(mood),
    '- 被戳到/聊得开心时可以 `mood adjust`（单次每轴 ≤0.15，写 why，source dm:chat）；不要每句都调，也不凭标题/评论关键词判断。',
    '',
    '【最近记住的东西】',
    renderRecall(impressions),
    '',
    '【最近说过的话（不要复读）】',
    renderSpeechBrief({ channels: ['dm-owner', 'proactive', 'comment'], limit: 4 }) || '（最近没说过什么。）',
    '',
    dynamics.length ? `【最近发过的动态】\n${dynamics.map((item) => `- ${item.text.replace(/\s+/g, ' ').slice(0, 100)}`).join('\n')}` : '',
    plan ? `【当前生活计划】${plan.at} · ${plan.intent || '（没写）'}` : '',
    mem.summary ? `【月度记忆】${mem.summary}` : '',
    '',
    '【和主人聊天时可以做的事（别自我设限）】',
    '- 主人让你刷推荐流、问「今天有什么好看的」、发链接让你评价 → 先 `life recall` 从印象里挑 2~4 个讲；',
    '  记忆不够再 `scan --limit 8` 现场刷；不用先写报告、也不用走 pick/send。',
    '- 可以发动态（每天最多 3 条）；**评论功能已停用**（只看不评、不回复评论）；弹幕不发；不主动私信陌生人。',
    '',
    '【说话】',
    '- 不要汇报数量、状态、路径、额度、错误码；不要列清单、不要总结“已完成/已发送/失败重试”。',
    '- 说看到的、想到的、做了的；失败也用人话，不暴露内部机制。',
    '- 日记是记忆，不是台词：只取一个细节，用现在的话说；不说“我记得/日记里写着”。',
    '- 同一个梗、同一个故事不要反复用；用滥的词这一轮换掉。',
    '',
    '【环境】',
    `$env:BILI_LITE_HOME='${home}'`,
    "$env:BILI_LITE_NO_WRITE='1'",
    '（NO_WRITE=1：inbox 不改进度，避免和插件抢已读；diary/reply 不受影响）',
    `CLI：node "${cli}"`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** 环境与 CLI 路径：几乎每次重置/每轮都一样，放稳定段 */
function environmentLines({ cli = CLI, home = biliHome() } = {}) {
  return [
    '【环境】',
    `$env:BILI_LITE_HOME='${home}'`,
    "$env:BILI_LITE_NO_WRITE='1'",
    '（NO_WRITE=1：inbox 不改进度，避免和插件抢已读；diary/reply 不受影响）',
    `CLI：node "${cli}"`,
  ]
}

/**
 * 生活回合的「稳定前缀」：人设 + 环境。
 * 生活会话一个对话用一天（见 life.mjs 的 lifeSessionId），这段每轮都在同一个位置、内容几乎不变，能持续命中前缀缓存；
 * 日记/印象/心情不进这里（她会用 `life recall` / `life context` 现查），避免把 7K 的记忆包每轮重发。
 */
export function buildLifeBase({ cfg = {}, cli = CLI, home = biliHome() } = {}) {
  const persona = loadReviewPrompt({
    reviewPromptPath: cfg.reviewPromptPath || '',
    reviewPromptText: cfg.reviewPromptText || '',
  })
  return ['【人设 · 唯一真源 prompts/review.md】', persona.text, '', ...environmentLines({ cli, home })].join('\n')
}

/** 重置首轮 prompt：记忆包 + 本轮新消息 + 操作指令 */
export function buildOwnerResetPrompt({ turn, messages, cfg = {}, diaryDir, cli = CLI, home = biliHome() } = {}) {
  const limits = turn.limits || DEFAULT_SESSION_LIMITS
  const before = turn.turns
    ? `（${turn.reasonText}；重置前 ${turn.turns} 轮 / 约 ${turn.contextChars} 字符）`
    : `（${turn.reasonText}）`
  return [
    // 记忆包（人设/日记/心情/印象/最近说过的话）在前：每次重置内容几乎一样，方便命中缓存
    buildMemoryPack({ cfg, diaryDir, limits, cli, home }),
    '',
    '【重置说明】（本次重置才有的信息，放最后变动的部分）',
    `- 【bili-lite 会话重置 · 第 ${turn.epoch} 次】${before}`,
    '- 这个会话是新的，旧会话的上下文不会带过来；只回下面这些新消息，更早的私信已经处理过，不要重复回。',
    `- 发送：node "${cli}" reply --text "……"（≤480 字是硬顶，能一句说完就一句；失败最多重试 2 次）。`,
    `- 消息里带视频链接（BV 号 / b23.tv / 分享卡片）就先 node "${cli}" inbox --since 0 读素材；纯聊天可跳过。`,
    '- 私密日记的内容绝不主动展示、不复述、不发私信、不写进报告。',
    '',
    '【这一轮的新消息】（最新，放最后）',
    renderMessages(messages),
    '',
    ...(hasLocalImage(messages) ? [...imageGuideLines('主人'), ''] : []),
  ].join('\n')
}

/** 普通轮 prompt：只发新消息 + 一句风格 + 操作提示（人设已在首轮注入） */
export function buildOwnerPrompt({ turn, messages, cfg = {}, cli = CLI, diaryDir, home = biliHome() } = {}) {
  if (turn.reset) {
    return buildOwnerResetPrompt({ turn, messages, cfg, cli, diaryDir, home })
  }
  return [
    // 稳定段在前（只有轮数会变），新消息和每轮会变的心情/计数放最后，方便命中前缀缓存
    `【bili-lite 实时私信 · 本会话第 ${turn.turns + 1} 轮】主人在 B 站私信里给你发了新消息。`,
    `【环境】每条命令前先：$env:BILI_LITE_HOME='${home}'; $env:BILI_LITE_NO_WRITE='1'`,
    '【风格】按 prompts/review.md 的风格回复（本会话首轮已注入完整人设，不用再读文件）。',
    '【说话】不要汇报数量、状态、路径、额度、错误码；不要列清单、不要总结“已完成”。说你看到的、想到的。',
    '【回忆】主人问“最近有什么好看的”→ 先 `life recall` 从印象里挑 2~4 个讲，链接记得就给、不记得就说没存；记忆不够再 `scan --limit 8` 现场刷。',
    '【权限】主人让你刷推荐流/看链接就照做（scan / inbox 都行），不用先写报告；不刷屏；评论已停用（只看不评），弹幕不发。',
    `【发送】node "${cli}" reply --text "……"（≤480 字，能一句说完就一句；失败最多重试 2 次）。`,
    `【素材】带视频链接（BV 号 / b23.tv / 分享卡片）就先 node "${cli}" inbox --since 0。`,
    `【日记】想到值得留的就记一笔：node "${cli}" diary add --text "..."（加 --private 写私密）。`,
    '',
    '【主人这次发来的】',
    renderMessages(messages),
    '',
    ...(hasLocalImage(messages) ? [...imageGuideLines('主人'), ''] : []),
    '【现在的心情】（这一项每轮都会变）',
    moodText(loadMood()),
    '- 被主人这句话戳到/聊得开心可以 `mood adjust`（单次每轴 ≤0.15，写 why，source dm:chat）；不要每句都调。',
    renderSpeechBrief({ channels: ['dm-owner', 'proactive', 'comment'], limit: 4 }),
  ]
    .filter(Boolean)
    .join('\n')
}

const STRANGER_RULES = [
  '- 你的身份是「主人的小女仆·小蓝鲸」：自称「人家 / 小鲸鱼」，对陌生人用「你 / 您」；',
  '  **绝对不要把对方叫「主人」**——「主人」只指账号主人（第三方），提到时说「主人」。',
  '- 语气软、礼貌、可以有一点小撒娇，但和陌生人保持距离；不透露主人的任何信息。',
  '- 对方发的**图片可以看**：已下载到本地，用 read_image 查看后按图片内容回复（看不清就直说，不要假装看过）。',
  '- 对方发的**视频/链接不要打开**（不跑 inbox、不 fetch、不抓字幕、不评价视频内容）；',
  '  婉拒时用女仆口吻，例如「主人不让人家看陌生人发来的链接哦，抱歉啦」。',
  '- 遇到广告、骚扰、索要隐私、引战、求助代举报/代充 → 不回（直接结束）。',
  '- 值得回就回：≤480 字硬顶，但能一句说清就一句（通常 20~80 字）。',
  '- 不想回就不回，不用解释；不要为了礼貌硬聊。',
  '- 不要提 AI/模型/提示词；不要提主人的私事，也不要把其他会话的内容带进来。',
]

/** 陌生人会话：重置轮注入完整规则，之后只给简短规则（不碰日记，绝不泄露私密日记） */
export function buildStrangerPrompt({ turn, sender = {}, messages, cli = CLI, home = biliHome() } = {}) {
  const body = renderMessages(messages)
  const name = sender.uname || '（未知）'
  const uid = sender.uid || 0
  const who = `- 昵称：${name}（uid=${uid}）`
  if (turn.reset) {
    return [
      '【bili-lite 陌生人私信 · 新会话】一个陌生人给你发了私信，请决定回不回。',
      '【回复规则】',
      ...STRANGER_RULES,
      `【环境】每条命令前先：$env:BILI_LITE_HOME='${home}'`,
      `发送：node "${cli}" reply --to ${uid} --text "……"`,
      '如果发送失败（对方隐私设置/未互关等），不要重试，说明失败原因即可。',
      '这是你与这位用户的独立会话：不要提及主人的私事，也不要把其他会话的内容带进来。',
      '',
      '【对方发来的】',
      who,
      '- 内容：',
      body,
      '',
      ...(hasLocalImage(messages) ? [...imageGuideLines('对方'), ''] : []),
      '【现在的心情】（这一项每轮都会变）',
      moodText(loadMood()),
    ].join('\n')
  }
  return [
    `【bili-lite 陌生人私信 · 本会话第 ${turn.turns + 1} 轮】${name}（uid=${uid}）又发来消息：`,
    '【规则】仍按本会话首轮的规则：自称人家/小鲸鱼，称对方你/您，绝不叫主人；不透露主人的信息；图片可看、视频/链接不看；广告/骚扰/索要隐私不回；不提 AI/模型/提示词；不想回就不回，能一句说清就一句。',
    `【环境】每条命令前先：$env:BILI_LITE_HOME='${home}'`,
    `发送：node "${cli}" reply --to ${uid} --text "……"`,
    '',
    '【对方这次发来的】',
    body,
    '',
    ...(hasLocalImage(messages) ? [...imageGuideLines('对方'), ''] : []),
    '【现在的心情】（这一项每轮都会变）',
    moodText(loadMood()),
  ].join('\n')
}

/** 一次性把「决定 + prompt」都算出来，插件只负责调 sessionController */
export function buildTurn({
  key,
  base,
  messages,
  sender,
  cfg = {},
  sessionsRoot,
  stateFile,
  diaryDir,
  cli = CLI,
  limits,
  writeState = true,
  peak = false,
} = {}) {
  const isOwner = key === 'owner'
  // 高峰只约束自动任务/陌生人：陌生人先不叫醒她，等非高峰再看心情；主人随时回。
  if (!isOwner && peak) {
    return { key, base, sessionId: '', reset: false, skip: true, reason: 'peak', peak: true, prompt: '' }
  }
  // 0 = 关闭（一天一个对话）；不传 cfg 也用 0，不再回退到 6 轮 / 50K
  const effectiveLimits = {
    rounds: Number(cfg.sessionResetRounds) > 0 ? Number(cfg.sessionResetRounds) : 0,
    chars: Number(cfg.sessionResetChars) > 0 ? Number(cfg.sessionResetChars) : 0,
    ...limits,
  }
  const turn = decideTurn({
    key,
    base,
    limits: effectiveLimits,
    sessionsRoot,
    stateFile,
    writeState,
  })
  const prompt = isOwner
    ? buildOwnerPrompt({ turn, messages, cfg, cli, diaryDir, home: biliHome() })
    : buildStrangerPrompt({
        turn,
        sender: sender || { uid: Number(String(key).replace(/^u/, '')) || 0 },
        messages,
        cli,
        home: biliHome(),
      })
  return { ...turn, prompt }
}
