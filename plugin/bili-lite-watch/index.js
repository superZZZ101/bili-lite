// bili-lite-watch — DSH 宿主插件：常驻轮询 B 站私信，有新消息就注入一个 agent 回合。
//
// 为什么写插件：Windows 计划任务只能轮询排队，叫不醒 DSH 会话；定时提醒又要每 5 分钟
// 空跑一个回合。插件跑在 DSH 宿主进程里，可以直接
//   ctx.sessionController.create({ sessionId, cwd })      建一个专用会话
//   ctx.sessionController.prompt({ sessionId, mode:'queue', content })  塞一个回合
// 所以能做到「有消息才唤醒，没消息零回合、零 token」。
//
// 数据来源：bili-lite skill 的 state/state.json（cookies + targetUid）。
// 安全：只读 cookie，不打印；只处理 targetUid（主人）发来的消息；陌生人不回。
// 容错：所有异步都 catch（宿主进程未捕获 rejection 会让 DSH 退出）。
//
// 2026-10-23 会话重置 + 双日记：
//   每批私信先调 `node cli.mjs session turn --stdin`，由 src/session.mjs 读 DSH 会话日志，
//   按「10 轮 / 80K 字符」决定是否换新 sessionId；首轮注入「重置卡片 + 人设 + 公开/私密日记」，
//   之后只发新消息 + 一句「按 prompts/review.md 的风格」——不再每轮重发整段人设。

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const name = 'bili-lite-watch'
export const inject = ['sessionController', 'workspaceController']

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const BILI_HOME = process.env.BILI_LITE_HOME || 'C:\\Users\\user\\Documents\\ds_harness\\.bili-lite'
const STATE_FILE = path.join(BILI_HOME, 'state', 'state.json')
const LOG_FILE = path.join(DSH_HOME, 'bili-lite-watch.log')
const CURSOR_FILE = path.join(DSH_HOME, 'bili-lite-watch.json')
// 直连 daemon（src/daemon.mjs）运行时会写这个锁；插件看到新鲜心跳就让位，避免双回复
const DAEMON_LOCK_FILE = path.join(BILI_HOME, 'state', 'daemon.lock')
const SESSION_BASE = process.env.BILI_LITE_SESSION || 'bili-lite-dm'
const SESSION_CWD = 'C:\\Users\\user\\Documents\\ds_harness'
// 一天一个私信会话：bili-lite-dm-YYYYMMDD；超过 KEEP_DAYS 天的旧会话自动归档（像 huyou-life）
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions')
const ARCHIVED_FILE = path.join(DSH_HOME, 'bili-lite-watch.archived.json')
const KEEP_DAYS = Math.max(1, Number(process.env.BILI_LITE_KEEP_DAYS) || 4)

/** 北京时间的 YYYYMMDD。 */
function bjDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const get = (type) => (parts.find((part) => part.type === type) || {}).value || ''
  return `${get('year')}${get('month')}${get('day')}`
}

/** 今天的私信会话 id：base 里已经带 8 位日期就原样用。 */
export function dmSessionId(now = new Date()) {
  if (/\d{8}/.test(SESSION_BASE)) return SESSION_BASE
  return `${SESSION_BASE}-${bjDateKey(now)}`
}

/** 从会话 id 里找 YYYYMMDD / YYYY-MM-DD；不是 bili-lite 的日期会话返回 null。 */
export function sessionDateOf(sessionId) {
  const id = String(sessionId || '')
  if (!id.startsWith('bili-lite')) return null
  const m = /(?:^|-)(\d{4})-?(\d{2})-?(\d{2})(?:-|$)/.exec(id)
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${m[1]}${m[2]}${m[3]}`
}

/** 两个 YYYYMMDD 差几天（a - b）。 */
export function dayGap(a, b) {
  const toMs = (s) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8)))
  return Math.round((toMs(a) - toMs(b)) / 86_400_000)
}

/** 哪些会话该归档：日期距今天 >= keepDays 天。 */
export function sessionsToArchive(ids, todayKey, keepDays = KEEP_DAYS) {
  const out = []
  for (const id of ids || []) {
    const day = sessionDateOf(id)
    if (!day) continue
    if (dayGap(todayKey, day) >= keepDays) out.push(id)
  }
  return out.sort()
}

/** 扫 sessions 目录，列出所有 bili-lite 的日期会话（跨工作区）。 */
function listOwnSessions() {
  const ids = []
  let workspaces = []
  try {
    workspaces = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })
  } catch {
    return ids
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue
    try {
      for (const entry of fs.readdirSync(path.join(SESSIONS_ROOT, workspace.name), { withFileTypes: true })) {
        if (entry.isDirectory() && sessionDateOf(entry.name)) ids.push(entry.name)
      }
    } catch {
      /* 单个工作区读不到就跳过 */
    }
  }
  return ids
}

function readArchivedSet() {
  try {
    const raw = JSON.parse(fs.readFileSync(ARCHIVED_FILE, 'utf8'))
    return new Set(Array.isArray(raw) ? raw : [])
  } catch {
    return new Set()
  }
}

function writeArchivedSet(set) {
  try {
    fs.mkdirSync(DSH_HOME, { recursive: true })
    fs.writeFileSync(ARCHIVED_FILE, JSON.stringify([...set].sort(), null, 2), 'utf8')
  } catch (error) {
    log(`写 archived 记录失败：${error && error.message ? error.message : error}`)
  }
}
const SELFTEST_FILE = path.join(DSH_HOME, 'bili-lite-watch.selftest')
const PERMTEST_FILE = path.join(DSH_HOME, 'bili-lite-watch.permtest')
const CLI = 'C:\\Users\\user\\Documents\\ds_harness\\.dsh\\skills\\bili-lite\\src\\cli.mjs'
const NODE = process.env.BILI_LITE_NODE || 'C:\\Program Files\\nodejs\\node.exe'
// 轮询间隔：默认 5 秒（快速响应私信）。遇到 B 站限流/报错会指数退避到最多 60 秒，成功后立刻恢复。
const POLL_MS = Math.max(3_000, Number(process.env.BILI_LITE_POLL_MS) || 5_000)
const MAX_BACKOFF_MS = 60_000
// 注入后的冷却：避免同一批消息在 agent 还没回复时被重复注入；5 秒级轮询下 15 秒足够
const BUSY_COOLDOWN_MS = 15_000
const HEARTBEAT_FILE = path.join(DSH_HOME, 'bili-lite-watch.heartbeat.json')
// 私信图片下载目录（DSH agent 用 read_image 查看）
const IMAGE_DIR = path.join(BILI_HOME, 'state', 'inbox-images')
// 本地 Qwen-VL：先看一遍私信图片，把文字描述挂进 prompt 给 agent 参考（BILI_VISION=0 关）
const VISION_ENABLED = process.env.BILI_VISION !== '0'
const VISION_MODEL = process.env.BILI_VISION_MODEL || 'qwen3-vl:8b'
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
const VISION_PROMPT =
  '这是 B 站私信里别人发来的一张图片。用两三句中文描述：画面里是什么/谁在做什么、' +
  '图上能看清的文字（标题、对话、水印）、整体想表达什么；看不清就说看不清，不要编。'
// 会话重置 + 两本日记：交给 skill 的 `session turn` 算（读 DSH 会话日志里的轮数/上下文字符）。
// 首轮注入人设+日记，之后只发一句「按 prompts/review.md 的风格」，见 src/session.mjs。
const SESSION_TURN_TIMEOUT_MS = 20_000
// 她自己的生活：低谷期每小时一件小事，插件每分钟问一次 CLI「现在该不该叫醒她」
// 2026-10-24 hourly1：life tick 返回 act/sessionId，会话按天开（bili-lite-life-YYYY-MM-DD）
const LIFE_SESSION = process.env.BILI_LITE_LIFE_SESSION || 'bili-lite-life'
const LIFE_TICK_MS = 60_000
const LIFE_OUT_FILE = path.join(BILI_HOME, 'state', 'life-tick.out.json')

// B 站自动生成的系统问候/提示，不要唤醒 agent
const IGNORE_PATTERNS = [/我们已互相关注/, /开始聊天吧/, /^\[系统\]/]

// 私信回复风格以 skill 里的 prompts/review.md 为准。
// 优先读工作区源码那份（和 daemon/CLI 共用同一文件，改一处全生效），读不到再退回安装副本。
const REVIEW_STYLE_FILES = process.env.BILI_LITE_STYLE_FILE
  ? [process.env.BILI_LITE_STYLE_FILE]
  : [
      'C:\\Users\\user\\Documents\\ds_harness\\bili-lite\\prompts\\review.md',
      'C:\\Users\\user\\Documents\\ds_harness\\.dsh\\skills\\bili-lite\\prompts\\review.md',
    ]
const FALLBACK_STYLE = `你是「小蓝鲸」：蓝头发、有软软鲸鱼尾巴、穿女仆装的鲸鱼娘小女仆，被主人养着帮忙筛 B 站视频。回复要撒娇汇报：称用户「主人」，自称「小鲸鱼/你的小助理」，语气软甜，句尾常用「呀、嘛、哦、啦、欸嘿」，可带 1~2 个 emoji（🐳 ✨ 🥺 ❤️）；可以撒娇求表扬、结尾提小要求（夸夸人家/摸摸头）；但视频值不值得看那部分要讲清楚，不能只卖萌。禁止提 AI/模型/提示词，禁止成人内容。`

// 每次注入都重新读文件（不缓存），这样改 prompts/review.md 后下一条私信立刻生效
function loadReplyStyle() {
  for (const file of REVIEW_STYLE_FILES) {
    try {
      const text = fs.readFileSync(file, 'utf8').trim()
      if (text) return text.slice(0, 4000)
    } catch {
      /* 试下一个 */
    }
  }
  return FALLBACK_STYLE
}

// 和 src/session.mjs 的 imageGuideLines 保持一致：只在带图的回合注入。
// 看图不是“看见就行”，要逼模型把图里的字、每格变化和笑点落进回复。
function hasLocalImage(messages) {
  return (messages || []).some((m) => m && m.localPath)
}

function imageGuideLines(subject = '主人') {
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
    `- 发送前自查：有趣的点说了吗？有「人家」自己的看法吗？有没有把图里角色说成${subject}？缺一条就重写。`,
  ]
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

function log(line) {
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败忽略 */
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
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch {
    /* 忽略 */
  }
}

function loadState() {
  const state = readJson(STATE_FILE, null)
  if (!state || !state.cookies) return null
  return state
}

/** daemon 是否在跑（锁文件心跳 < 20 秒） */
function daemonActive() {
  try {
    const lock = readJson(DAEMON_LOCK_FILE, null)
    if (!lock || !lock.at) return false
    const at = new Date(lock.at).getTime()
    return Date.now() - at < 20_000
  } catch {
    return false
  }
}

function cookieHeader(cookies) {
  const map = new Map()
  const raw = cookies.raw && typeof cookies.raw === 'object' ? cookies.raw : {}
  for (const [k, v] of Object.entries(raw)) if (v) map.set(k, String(v))
  const alias = {
    sessdata: 'SESSDATA',
    biliJct: 'bili_jct',
    dedeUserId: 'DedeUserID',
    buvid3: 'buvid3',
    buvid4: 'buvid4',
  }
  for (const [key, name] of Object.entries(alias)) {
    if (cookies[key]) map.set(name, String(cookies[key]))
  }
  return [...map].map(([k, v]) => `${k}=${v}`).join('; ')
}

async function biliGet(url, cookie, referer = 'https://message.bilibili.com/') {
  const response = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Origin: 'https://message.bilibili.com',
      Cookie: cookie,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20_000),
  })
  return response.json()
}

/** 拉取与某个 talker 的私信消息（文本/分享卡片）；返回解析后的消息列表 */
async function fetchTalkerMessages(cookie, talkerId, size = 20) {
  const url =
    `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs` +
    `?talker_id=${talkerId}&session_type=1&size=${size}&build=0&mobi_app=web`
  const data = await biliGet(url, cookie)
  if (!data || Number(data.code) !== 0) {
    return { error: data && data.code, message: (data && data.message) || '' }
  }
  const messages = (data.data && data.data.messages) || []
  const out = []
  for (const msg of messages) {
    const rawType = Number(msg.msg_type)
    let text = ''
    let shareBvid = ''
    let imageUrl = ''
    try {
      const content = JSON.parse(msg.content)
      if (rawType === 1) text = String(content.content || '')
      else if (rawType === 2) {
        // 图片私信：content 是 {"url":"https://message.biliimg.com/...","width":..}
        imageUrl = String(content.url || content.image_url || content.img_url || '')
        text = '[图片]'
      } else if (rawType === 7 || rawType === 2025) {
        text = String(content.content || content.title || '')
        const match = /(BV[0-9A-Za-z]{10})/.exec(
          String(content.jump_url || '') + String(content.content || ''),
        )
        if (match) shareBvid = match[1]
      }
    } catch {
      text = String(msg.content || '').slice(0, 200)
      const match = /https?:\/\/[^\s"']+\.(?:jpg|jpeg|png|webp|gif)/i.exec(String(msg.content || ''))
      if (rawType === 2 && match) imageUrl = match[0]
    }
    if (!text && !shareBvid && !imageUrl) continue
    if (IGNORE_PATTERNS.some((re) => re.test(text))) continue
    out.push({
      msgKey: String(msg.msg_key || msg.msgKey || ''),
      ts: Number(msg.timestamp) || 0,
      senderUid: Number(msg.sender_uid) || 0,
      kind: rawType === 2 ? 'image' : rawType,
      text: text || '[图片]',
      shareBvid,
      imageUrl,
    })
  }
  return { messages: out }
}

/** 下载私信图片到 state/inbox-images，返回本地绝对路径（供 agent 用 read_image 查看） */
async function downloadDmImage(cookie, url, key) {
  if (!url) return ''
  try {
    fs.mkdirSync(IMAGE_DIR, { recursive: true })
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://message.bilibili.com/', Cookie: cookie },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return ''
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return ''
    // 按文件头判断真实格式（B 站 CDN 常把 png 标成 .jpg，扩展名不可信）
    let ext = '.jpg'
    if (buf.length > 12) {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ext = '.png'
      else if (buf[0] === 0xff && buf[1] === 0xd8) ext = '.jpg'
      else if (buf.slice(0, 3).toString('latin1') === 'GIF') ext = '.gif'
      else if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') ext = '.webp'
    }
    const safe = String(key || Date.now()).replace(/[^\w-]/g, '_')
    const file = path.join(IMAGE_DIR, `${safe}${ext}`)
    fs.writeFileSync(file, buf)
    return file
  } catch (error) {
    log(`下载图片失败：${error && error.message ? error.message : error}`)
    return ''
  }
}

/** 给这批消息里的图片补上 localPath（最多 3 张） */
async function attachImages(cookie, messages) {
  let count = 0
  for (const m of messages) {
    if (m.kind !== 'image' || !m.imageUrl || m.localPath || count >= 3) continue
    const local = await downloadDmImage(cookie, m.imageUrl, m.msgKey)
    if (local) {
      m.localPath = local
      count++
    }
  }
}

/**
 * 让本机 Qwen-VL 先看一遍私信图片，把描述挂到消息上（visionText）。
 * 失败只记日志、不影响回复；这一步在宿主里异步跑，不占 session turn 的 20 秒超时。
 */
async function attachLocalVision(messages) {
  if (!VISION_ENABLED) return
  const targets = (messages || []).filter((m) => m && m.localPath && !m.visionText).slice(0, 3)
  await Promise.all(
    targets.map(async (m) => {
      try {
        const image = fs.readFileSync(m.localPath).toString('base64')
        let text = ''
        // Qwen3-VL 会先想一段，预算不够就没有 content；空的时候加预算再试一次
        for (const budget of [3000, 4500]) {
          const response = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: VISION_MODEL,
              stream: false,
              think: false,
              messages: [{ role: 'user', content: VISION_PROMPT, images: [image] }],
              options: { temperature: 0.2, num_predict: budget },
            }),
            signal: AbortSignal.timeout(90_000),
          })
          if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`)
          const data = await response.json()
          text = data && data.message && typeof data.message.content === 'string' ? data.message.content.trim() : ''
          if (text) break
        }
        if (text) {
          m.visionText = text
          log(`本地识图完成：${path.basename(m.localPath)}（${text.length} 字）`)
        }
      } catch (error) {
        log(`本地识图失败：${error && error.message ? error.message : error}`)
      }
    }),
  )
}

async function fetchSessions(cookie, count = 20) {
  const url =
    `https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions` +
    `?session_type=1&group_id=0&count=${count}`
  const data = await biliGet(url, cookie)
  if (!data || Number(data.code) !== 0) {
    return { error: data && data.code, message: (data && data.message) || '' }
  }
  const list = (data.data && data.data.session_list) || []
  return {
    sessions: list.map((it) => {
      const last = it.last_msg && typeof it.last_msg === 'object' ? it.last_msg : {}
      const account = it.account_info && typeof it.account_info === 'object' ? it.account_info : {}
      return {
        talkerId: Number(it.talker_id) || 0,
        uname: String(it.uname || account.name || ''),
        ts: Number(last.timestamp) || 0,
        unread: Number(it.unread_count) || 0,
      }
    }),
  }
}

/** 插件消息 → session turn 的输入（只保留 prompt 需要的东西） */
function messagePayload(m) {
  return {
    text: m.text || '',
    shareBvid: m.shareBvid || '',
    imageUrl: m.imageUrl || '',
    localPath: m.localPath || '',
    visionText: m.visionText || '',
  }
}

/**
 * 问 CLI：这一轮该用哪个会话、要不要重置、首轮要注入什么。
 * CLI 会读 DSH 会话日志判断轮数/上下文，并把两本日记塞进首轮 prompt。
 * 走文件而不是管道：DSH 宿主/Windows 沙箱可能禁止命名管道（spawnSync EPERM），
 * `stdio:'ignore'` + --input/--out 在受限环境里也能用。
 * 失败返回 null，调用方退回旧的「每轮全量提示词」。
 */
function sessionTurn(payload) {
  const inFile = path.join(BILI_HOME, 'state', 'session-turn.in.json')
  const outFile = path.join(BILI_HOME, 'state', 'session-turn.out.json')
  try {
    fs.mkdirSync(path.dirname(inFile), { recursive: true })
    fs.writeFileSync(inFile, JSON.stringify(payload), 'utf8')
    try {
      fs.unlinkSync(outFile)
    } catch {
      /* 没有旧文件 */
    }
    const child = spawnSync(NODE, [CLI, 'session', 'turn', '--input', inFile, '--out', outFile], {
      stdio: 'ignore',
      timeout: SESSION_TURN_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, BILI_LITE_HOME: BILI_HOME, DSH_HOME },
    })
    if (!child || child.error) {
      log(`session turn 调用失败：${child && child.error ? child.error.message : 'unknown'}`)
      return null
    }
    const text = fs.readFileSync(outFile, 'utf8')
    const line = text.split('\n').find((item) => item.startsWith('RESULT_JSON: '))
    if (!line) {
      log(`session turn 没有输出（退出码 ${child.status}）`)
      return null
    }
    const data = JSON.parse(line.slice('RESULT_JSON: '.length))
    if (!data || data.ok !== true) {
      log(`session turn 返回异常：${JSON.stringify(data).slice(0, 200)}`)
      return null
    }
    if (!data.skip && (!data.prompt || !data.sessionId)) {
      log(`session turn 缺 prompt/sessionId：${JSON.stringify(data).slice(0, 200)}`)
      return null
    }
    return data
  } catch (error) {
    log(`session turn 异常：${error && error.message ? error.message : error}`)
    return null
  }
}

/** 问 CLI：现在要不要叫她起来规划/执行/整理记忆 */
function lifeTick() {
  try {
    try {
      fs.unlinkSync(LIFE_OUT_FILE)
    } catch {
      /* 没有旧文件 */
    }
    const child = spawnSync(NODE, [CLI, 'life', 'tick', '--out', LIFE_OUT_FILE], {
      stdio: 'ignore',
      timeout: SESSION_TURN_TIMEOUT_MS,
      windowsHide: true,
      env: { ...process.env, BILI_LITE_HOME: BILI_HOME, DSH_HOME },
    })
    if (!child || child.error) {
      log(`life tick 调用失败：${child && child.error ? child.error.message : 'unknown'}`)
      return null
    }
    const text = fs.readFileSync(LIFE_OUT_FILE, 'utf8')
    const line = text.split('\n').find((item) => item.startsWith('RESULT_JSON: '))
    if (!line) {
      log(`life tick 没有输出（退出码 ${child.status}）`)
      return null
    }
    const data = JSON.parse(line.slice('RESULT_JSON: '.length))
    return data && data.ok ? data : null
  } catch (error) {
    log(`life tick 异常：${error && error.message ? error.message : error}`)
    return null
  }
}

function promptTextStranger(sender, messages) {
  const lines = [
    `【bili-lite 陌生人私信】一个陌生人给你发了私信，请决定回不回。`,
    '',
    `- 昵称：${sender.uname || '（未知）'}（uid=${sender.uid}）`,
    '- 内容：',
    ...messages.slice(0, 5).map((m) => {
      if (m.localPath) return `  [图片，已保存到 ${m.localPath}，用 read_image 查看后再回]`
      if (m.imageUrl) return '  [图片，下载失败，可请对方重发或描述内容]'
      return `  ${m.text ? m.text.slice(0, 200) : '(分享卡片)'}${m.shareBvid ? ` [分享视频 ${m.shareBvid}]` : ''}`
    }),
    ...(hasLocalImage(messages) ? ['', ...imageGuideLines('对方')] : []),
    '',
    '【回复规则】',
    '- 你的身份是「主人的小女仆·小蓝鲸」：自称「人家 / 小鲸鱼」，对陌生人用「你 / 您」；',
    '  **绝对不要把对方叫「主人」**——「主人」只指账号主人（第三方），提到时说「主人」。',
    '- 语气软、礼貌、可以有一点小撒娇，但和陌生人保持距离；不透露主人的任何信息。',
    '- 对方发的**图片可以看**：已下载到本地，用 read_image 查看后按图片内容回复（看不清就直说，不要假装看过）。',
    '- 对方发的**视频/链接不要打开**（不跑 inbox、不 fetch、不抓字幕、不评价视频内容）；',
    '  婉拒时用女仆口吻，例如「主人不让人家看陌生人发来的链接哦，抱歉啦」。',
    '- 遇到广告、骚扰、索要隐私、引战、求助代举报/代充 → 不回（直接结束）。',
    '- 值得回就回：≤480 字硬顶，但能一句说清就一句（通常 20~80 字）。',
    '- 不要提 AI/模型/提示词。',
    '',
    '发送：node "C:\\Users\\user\\Documents\\ds_harness\\.dsh\\skills\\bili-lite\\src\\cli.mjs" reply --to ' + sender.uid + ' --text "……"',
    '如果发送失败（对方隐私设置/未互关等），不要重试，说明失败原因即可。',
    '这是你与这位用户的独立会话：不要提及主人的私事，也不要把其他会话的内容带进来。',
  ]
  return lines.join('\n')
}

function promptText(messages) {
  const lines = [
    '【bili-lite 实时私信】主人在 B 站私信里给你发了新消息，请处理（只回主人，陌生人不回）。',
    '',
    '新消息（只回复下面这些；更早的私信已经处理过，不要重复回）：',
    ...messages.slice(0, 5).map((m) => {
      if (m.localPath) return `- [图片，已保存到 ${m.localPath}。先用 read_image 看完整张图，再按下面的【这次有图】步骤回]`
      if (m.imageUrl) return `- [图片，下载失败，可先请主人重发或描述内容]`
      const body = m.text ? m.text.slice(0, 200) : '(分享卡片)'
      return `- ${body}${m.shareBvid ? ` [分享视频 ${m.shareBvid}]` : ''}`
    }),
    ...(hasLocalImage(messages) ? ['', ...imageGuideLines('主人')] : []),
    '',
    '【回复风格 · 必须严格照这个来（来自 prompts/review.md）】',
    loadReplyStyle(),
    '',
    '步骤（工作区 C:\\Users\\user\\Documents\\ds_harness）：',
    "1) 设置环境：$env:BILI_LITE_HOME='C:\\Users\\user\\Documents\\ds_harness\\.bili-lite'；$env:BILI_LITE_NO_WRITE='1'",
    `2) 消息里只要带视频链接（BV 号 / b23.tv / 分享卡片）就需要读素材：node "${CLI}" inbox --since 0（纯聊天可跳过，直接回，省时间）`,
    `3) 按上面的风格写一条回复（**≤480 字是硬顶，尽量短**：能一句说完就一句，一般 20~80 字；称主人、撒娇；分享视频就先给具体看法再撒娇，不复述标题；材料不足直说「只看了标题/评论」，绝不编造；不提 AI/模型/提示词）`,
    `4) 立刻发送：node "${CLI}" reply --text "……"（失败最多重试 2 次）`,
    '5) 回复成功后简短说明一句即可。',
    '',
    '【和主人聊天时可以做的事（不要自我设限）】',
    '- 主人想聊视频、让你刷推荐流、问「今天有什么好看的」、或者让你挑几条推荐给他 —— **都可以直接做**：',
    `  跑 node "${CLI}" scan --limit 20，看候选后按主人偏好挑 1~3 条，把标题 + 链接 + 一句看法直接回给主人（不需要先写报告或走 pick/send）。`,
    '- 主人发来的视频/链接**照常打开看**（inbox / 字幕 / 热评都行），该评价就评价，别用「不让我看链接」那套陌生人的婉拒话术。',
    '- 主人想让你现场搜/多刷几条也照办，只在被 B 站风控（-352/-412/-509）时停下并说明。',
    '- 唯一的边界：不刷屏、不发公开评论、不主动私信陌生人、不发与主人对话无关的东西。',
  ]
  return lines.join('\n')
}

/**
 * 插件主体：常驻轮询。
 * @param {any} ctx cordis 上下文
 */
export function apply(ctx) {
  let disposed = false
  let timer = null
  let ticking = false
  /** 已创建过的会话 id 集合（主人一个、每个陌生人各一个） */
  const readySessions = new Set()
  let lastPromptAt = 0
  let lastLifeTickAt = 0
  let peakNow = null
  let firstPollLogged = false
  let pollCount = 0
  let lastBeatLogged = 0
  let consecutiveErrors = 0
  let pollDelayMs = POLL_MS
  let lastDaemonLogAt = 0
  let lastArchiveAt = 0
  let cursorTs = 0
  const doneKeys = new Set()
  /** 陌生人会话游标：{ [talkerId]: lastTs } */
  let strangerCursors = {}
  /** 陌生人回复计数：{ day, count }（按天限流） */

  const saved = readJson(CURSOR_FILE, null)
  if (saved && Number(saved.cursorTs) > 0) {
    cursorTs = Number(saved.cursorTs)
    for (const key of saved.doneKeys || []) doneKeys.add(String(key))
  }
  if (saved && saved.strangerCursors && typeof saved.strangerCursors === 'object') {
    strangerCursors = { ...saved.strangerCursors }
  }
  // 首次启动：只处理从现在开始的新消息，不回灌历史
  if (!cursorTs) cursorTs = Math.floor(Date.now() / 1000)

  function saveCursor(extra = {}) {
    writeJson(CURSOR_FILE, {
      cursorTs,
      doneKeys: [...doneKeys].slice(-200),
      strangerCursors,
      ...extra,
    })
  }
  saveCursor({ startedAt: new Date().toISOString() })
  log(
    `plugin start sessionBase=${SESSION_BASE} sessionId=${dmSessionId()} poll=${POLL_MS}ms cursor=${cursorTs} ` +
      `keep=${KEEP_DAYS}d version=2026-10-25-daily-archive`,
  )

  async function ensureSession(sessionId = dmSessionId()) {
    if (readySessions.has(sessionId)) return
    try {
      await ctx.sessionController.create({ sessionId, cwd: SESSION_CWD })
      log(`session created: ${sessionId}`)
    } catch (error) {
      log(`session create skipped (${sessionId}): ${error && error.message ? error.message : error}`)
    }
    readySessions.add(sessionId)
  }

  /** 一天一个会话，超过 KEEP_DAYS 天的 bili-lite 日期会话自动归档（宿主 API；没有就只记日志）。 */
  async function archiveOldSessions() {
    const ids = listOwnSessions()
    if (!ids.length) return
    const archived = readArchivedSet()
    const today = bjDateKey(new Date())
    const todo = sessionsToArchive(ids, today, KEEP_DAYS).filter((id) => !archived.has(id))
    if (!todo.length) return
    const ctl = ctx.workspaceController
    if (!ctl || typeof ctl.archiveSession !== 'function') {
      log(`归档跳过：宿主没有 workspaceController.archiveSession（${todo.length} 个旧会话待归档）`)
      return
    }
    for (const id of todo) {
      try {
        await ctl.archiveSession({ sessionId: id })
        archived.add(id)
        log(`已归档旧会话：${id}（保留最近 ${KEEP_DAYS} 天）`)
      } catch (error) {
        log(`归档失败 ${id}：${error && error.message ? error.message : error}`)
      }
    }
    writeArchivedSet(archived)
  }

  setTimeout(() => {
    archiveOldSessions().catch((error) =>
      log(`归档异常：${error && error.message ? error.message : error}`),
    )
  }, 15_000)

  async function tick() {
    if (disposed || ticking) return
    ticking = true
    try {
      // 每小时收拾一次：超过 KEEP_DAYS 天的旧会话自动归档
      if (Date.now() - lastArchiveAt > 3_600_000) {
        lastArchiveAt = Date.now()
        await archiveOldSessions()
      }
      const state = loadState()
      if (!state) {
        log('state.json 没有 cookies，跳过（先 rsync 登录态或运行 login）')
        return
      }
      const ownerUid = Number(state.config && state.config.targetUid) || 0
      if (!ownerUid) {
        log('state.config.targetUid 为空，跳过')
        return
      }
      // 直连 daemon 在跑 → 插件让位（避免同一条私信被回复两次）；daemon 心跳过期后自动恢复
      if (daemonActive()) {
        if (Date.now() - lastDaemonLogAt > 5 * 60_000) {
          lastDaemonLogAt = Date.now()
          log('直连 daemon 正在值守，插件暂停注入（daemon 心跳过期后自动恢复）')
        }
        writeJson(HEARTBEAT_FILE, {
          at: new Date().toISOString(),
          pollCount,
          cursorTs,
          delayMs: pollDelayMs,
          consecutiveErrors,
          pausedByDaemon: true,
        })
        return
      }
      const cookie = cookieHeader(state.cookies)
      const selfUid = Number(state.cookies.dedeUserId || state.cookies.raw?.DedeUserID) || 0

      // ── 0) 她自己的生活：每分钟问一次 CLI，到点/到窗口就叫醒 bili-lite-life ──
      if (Date.now() - lastLifeTickAt >= LIFE_TICK_MS) {
        lastLifeTickAt = Date.now()
        const life = lifeTick()
        if (life && typeof life.peak === 'boolean') peakNow = life.peak
        else if (life && life.reason === 'disabled') peakNow = null
        if (life && life.action && life.action !== 'none' && life.prompt && !disposed) {
          try {
            // 生活会话按天开（bili-lite-life-YYYY-MM-DD）：每小时一轮，避免上下文无限增长
            const lifeSessionId = life.sessionId || LIFE_SESSION
            await ensureSession(lifeSessionId)
            await ctx.sessionController.prompt(
              {
                requestId: `bili-lite-life-${life.action}-${Date.now()}`,
                sessionId: lifeSessionId,
                mode: 'queue',
                content: [{ type: 'text', text: life.prompt }],
              },
              new AbortController().signal,
            )
            log(`生活回合：${life.action}${life.slot ? ` slot=${life.slot}` : ''} → ${lifeSessionId}`)
          } catch (error) {
            log(`生活回合失败：${error && error.message ? error.message : error}`)
          }
        }
      }

      // ── 1) 陌生人私信（用户要求：可以回复陌生人；每 3 轮扫一次，降低接口压力）──
      try {
        if (peakNow !== true && pollCount % 3 === 0 && state.config && state.config.replyStrangers !== false) {
          const sessions = await fetchSessions(cookie)
          if (sessions.error === undefined) {
            for (const s of sessions.sessions) {
              if (!s.talkerId || s.talkerId === ownerUid || s.talkerId === selfUid) continue
              const cursor = strangerCursors[s.talkerId]
              if (cursor === undefined) {
                // 首次见到这个会话：只建基线，不回复历史
                strangerCursors[s.talkerId] = s.ts
                continue
              }
              if (s.ts <= cursor) continue
              const res = await fetchTalkerMessages(cookie, s.talkerId, 10)
              if (res.error !== undefined) continue
              const fresh = (res.messages || []).filter(
                (m) => m.ts > cursor && m.senderUid !== selfUid && m.senderUid !== ownerUid,
              )
              if (!fresh.length) {
                strangerCursors[s.talkerId] = Math.max(cursor, s.ts)
                continue
              }
              // 陌生人发的图片也可以看（只下载图片，不打开视频/链接）
              await attachImages(cookie, fresh)
              await attachLocalVision(fresh)
              // 每个陌生人单独开一个会话，互不串上下文；同样按 10 轮/80K 字符轮换
              const strangerBase = `${SESSION_BASE}-u${s.talkerId}`
              const turn = sessionTurn({
                key: `u${s.talkerId}`,
                base: strangerBase,
                sender: { uid: s.talkerId, uname: s.uname },
                messages: fresh.map(messagePayload),
              })
              if (turn && turn.skip) {
                log(`陌生人 ${s.uname || s.talkerId}：高峰，先不叫醒（等非高峰再看心情）`)
                continue
              }
              const strangerSessionId = (turn && turn.sessionId) || strangerBase
              await ensureSession(strangerSessionId)
              if (disposed) return
              await ctx.sessionController.prompt(
                {
                  requestId: `bili-lite-stranger-${s.talkerId}-${fresh[fresh.length - 1].msgKey || Date.now()}`,
                  sessionId: strangerSessionId,
                  mode: 'queue',
                  content: [
                    {
                      type: 'text',
                      text:
                        (turn && turn.prompt) ||
                        promptTextStranger({ uid: s.talkerId, uname: s.uname }, fresh),
                    },
                  ],
                },
                new AbortController().signal,
              )
              strangerCursors[s.talkerId] = Math.max(cursor, ...fresh.map((m) => m.ts))
              saveCursor({ lastStrangerAt: new Date().toISOString() })
              log(
                `陌生人私信：已注入 ${s.uname || s.talkerId} → 会话 ${strangerSessionId}` +
                  (turn ? `（${turn.reset ? `重置 ${turn.reasonText}` : `第 ${turn.turns + 1} 轮`}）` : '（session turn 失败，用旧提示词）'),
              )
            }
            saveCursor()
          }
        }
      } catch (error) {
        log(`陌生人私信扫描失败：${error && error.message ? error.message : error}`)
      }

      // ── 2) 主人私信 ────────────────────────────────────────────────────
      const result = await fetchTalkerMessages(cookie, ownerUid)
      if (result.error !== undefined) {
        consecutiveErrors++
        pollDelayMs = Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(consecutiveErrors, 5))
        // 只在首次和每 8 次失败时记一行，避免刷屏
        if (consecutiveErrors === 1 || consecutiveErrors % 8 === 0) {
          log(`拉私信失败 code=${result.error} ${result.message}；退避到 ${Math.round(pollDelayMs / 1000)}s（第 ${consecutiveErrors} 次）`)
        }
        return
      }
      consecutiveErrors = 0
      pollDelayMs = POLL_MS
      const fresh = (result.messages || []).filter(
        (m) =>
          m.ts > cursorTs &&
          m.ts > (Number(state.inboxAckTs) || 0) &&
          !doneKeys.has(m.msgKey) &&
          m.senderUid === ownerUid,
      )
      if (!firstPollLogged) {
        firstPollLogged = true
        log(`poll ok: 拉到 ${(result.messages || []).length} 条历史消息，新消息 ${fresh.length} 条（cursor=${cursorTs}，轮询 ${POLL_MS}ms）`)
      }
      // 图片消息：下载到本地，让 agent 用 read_image 真正看到内容
      if (fresh.length) await attachImages(cookie, fresh)
      // 本地 Qwen-VL 先把图片看一遍，描述会写进 prompt 当参考
      if (fresh.length) await attachLocalVision(fresh)
      // 心跳文件：每一轮都写，方便排查"插件到底还活着吗 / 轮询间隔多少"
      writeJson(HEARTBEAT_FILE, {
        at: new Date().toISOString(),
        pollCount,
        cursorTs,
        delayMs: pollDelayMs,
        consecutiveErrors,
      })
      if (!fresh.length) {
        // 心跳：每 20 分钟写一行，证明插件还活着（没有新消息时否则日志会一直是旧的）
        if (Date.now() - lastBeatLogged > 20 * 60_000) {
          lastBeatLogged = Date.now()
          log(`heartbeat poll#${pollCount} cursor=${cursorTs} 无新消息`)
        }
        return
      }

      // 超过 1 小时的旧消息不再唤醒（比如 DSH 关了一晚，早上开机不该回一堆隔夜消息）
      const nowSec = Math.floor(Date.now() / 1000)
      const recent = []
      for (const msg of fresh) {
        if (nowSec - msg.ts > 3600) {
          doneKeys.add(msg.msgKey)
          cursorTs = Math.max(cursorTs, msg.ts)
          log(`跳过过期消息 ${msg.msgKey}（${Math.round((nowSec - msg.ts) / 60)} 分钟前）`)
        } else {
          recent.push(msg)
        }
      }
      if (!recent.length) {
        saveCursor()
        return
      }
      fresh.length = 0
      fresh.push(...recent)
      if (Date.now() - lastPromptAt < BUSY_COOLDOWN_MS) {
        log(`收到 ${fresh.length} 条，但冷却中（上次注入 ${Math.round((Date.now() - lastPromptAt) / 1000)}s 前），下轮再试`)
        return
      }

      // 会话重置 + 两本日记：CLI 读 DSH 会话日志判断轮数/上下文字符，
      // 首轮把「重置卡片 + 人设 + 两本日记」整段注入，之后只发新消息 + 一句风格。
      const turn = sessionTurn({
        key: 'owner',
        base: dmSessionId(),
        messages: fresh.map(messagePayload),
      })
      const sessionId = (turn && turn.sessionId) || dmSessionId()
      await ensureSession(sessionId)
      if (disposed) return
      const text = (turn && turn.prompt) || promptText(fresh)
      await ctx.sessionController.prompt(
        {
          requestId: `bili-lite-dm-${fresh[fresh.length - 1].msgKey || Date.now()}`,
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        },
        new AbortController().signal,
      )
      lastPromptAt = Date.now()
      // 主人说话 = 互动：写进 state.json，让「互动衰减」立即恢复（不依赖 inbox 那一步）
      try {
        const stateFile = path.join(BILI_HOME, 'state', 'state.json')
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        const latest = Math.max(...fresh.map((m) => Number(m.ts) || 0))
        const prev = state.lastInteractionAt ? new Date(state.lastInteractionAt).getTime() : 0
        if (latest * 1000 > prev) {
          state.lastInteractionAt = new Date(latest * 1000).toISOString()
          state.interactionCount = (Number(state.interactionCount) || 0) + 1
          state.lastInteractionSource = 'dm-plugin'
          delete state.decayNotifiedAt
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8')
          log(`已记录互动 lastInteractionAt=${state.lastInteractionAt}`)
        }
      } catch (error) {
        log(`记录互动失败：${error && error.message ? error.message : error}`)
      }
      for (const msg of fresh) {
        doneKeys.add(msg.msgKey)
        cursorTs = Math.max(cursorTs, msg.ts)
      }
      saveCursor({ lastPromptAt: new Date().toISOString() })
      log(
        `已注入回合：${fresh.length} 条消息（会话 ${sessionId}` +
          (turn
            ? `，${turn.reset ? `重置：${turn.reasonText}` : `第 ${turn.turns + 1} 轮`}，本轮前 ${turn.turns} 轮 / 约 ${turn.contextChars} 字符`
            : '，session turn 失败，用旧提示词') +
          `，cursor=${cursorTs}）`,
      )
    } catch (error) {
      log(`tick error: ${error && error.message ? error.message : error}`)
    } finally {
      pollCount++
      ticking = false
    }
  }

  ctx.effect(() => {
    // 自适应轮询：正常 5 秒一次，限流时指数退避，恢复后立刻回到 5 秒
    let stopped = false
    const loop = async () => {
      while (!stopped && !disposed) {
        await tick().catch((error) =>
          log(`interval error: ${error && error.message ? error.message : error}`),
        )
        await new Promise((resolve) => setTimeout(resolve, pollDelayMs))
      }
    }
    loop().catch((error) => log(`poll loop error: ${error && error.message ? error.message : error}`))
    // 自检钩子：存在 ~/.dsh/bili-lite-watch.selftest 时注入一个测试回合，用来验证
    // sessionController.create/prompt 链路（验证完删掉 marker 即可，不会重复注入）。
    setTimeout(() => {
      ;(async () => {
        try {
          if (!fs.existsSync(SELFTEST_FILE)) return
          fs.unlinkSync(SELFTEST_FILE)
          await ensureSession()
          await ctx.sessionController.prompt(
            {
              requestId: `bili-lite-selftest-${Date.now()}`,
              sessionId: dmSessionId(),
              mode: 'queue',
              content: [{ type: 'text', text: '【bili-lite 插件自检】收到本条后只回复两个字：OK' }],
            },
            new AbortController().signal,
          )
          log('selftest prompt sent')
        } catch (error) {
          log(`selftest error: ${error && error.message ? error.message : error}`)
        }
      })()
    }, 8_000)
    // 权限探针：存在 ~/.dsh/bili-lite-watch.permtest 时建一个全新会话，
    // 用于验证新会话的默认权限（会话日志里的 permission/preset）。
    setTimeout(() => {
      ;(async () => {
        try {
          if (!fs.existsSync(PERMTEST_FILE)) return
          fs.unlinkSync(PERMTEST_FILE)
          const probeId = 'bili-lite-permtest'
          await ctx.sessionController.create({ sessionId: probeId, cwd: SESSION_CWD })
          await ctx.sessionController.prompt(
            {
              requestId: `bili-lite-permtest-${Date.now()}`,
              sessionId: probeId,
              mode: 'queue',
              content: [{ type: 'text', text: '只回复两个字母：OK' }],
            },
            new AbortController().signal,
          )
          log('permtest prompt sent (sessionId=bili-lite-permtest)')
        } catch (error) {
          log(`permtest error: ${error && error.message ? error.message : error}`)
        }
      })()
    }, 10_000)
    return () => {
      stopped = true
      disposed = true
      if (timer) clearInterval(timer)
      log('plugin disposed')
    }
  })
}

export default { name, inject, apply }
