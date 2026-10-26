// src/frames.mjs — 给视频抽几张画面，让 AI 真的“看到”一点
//
// 两条路：
// 1. 普通（主动少看）：用 B 站 videoshot 的雪碧图 + index 选 1~12 张（480×270），不下载视频。
// 2. 密集（默认，1.2 帧/秒）：用 ffmpeg 解码视频按 fps=6/5 抽帧，3×3 拼成联络表。
//    ffmpeg 找不到就退回 videoshot 能给的帧（约 20 帧/100 秒，见 selectDensePlan）。
// 每次抽帧写进自己的 run 子目录（state/frames/<bvid>/<run>/），旧 run 不会混进新结果。
// 依赖：Python 3 + Pillow 必装；ffmpeg 只影响密集模式（可选）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { STATE_DIR } from './state.mjs'
import { currentContext } from './react.mjs'
import { videoDetail } from './bili.mjs'
import { DEFAULT_HEADERS } from './http.mjs'
import { DEFAULT_VISION_MODEL, describeImage, describeImages, visionPrompt } from './vision.mjs'

export const FRAMES_DIR = path.join(STATE_DIR, 'frames')
const REFERER = 'https://www.bilibili.com/'
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 密集模式的目标帧率：1.2 帧/秒（2026-10-26 用户要求从 63/100 提到 1.2）。 */
export const DENSE_FPS = 6 / 5
const DENSE_FPS_EXPR = '6/5'

/**
 * 解析帧率表达式：`63/100`、`1.2`、`120/100` 都认。
 * 帧率可配置：BILI_DENSE_FPS=0.63 或 frames --fps 0.63（默认 6/5 = 1.2）。
 * @returns {{expr:string, fps:number}} expr 给 ffmpeg，fps 给算时间戳
 */
export function parseFpsExpr(raw, fallback = { expr: DENSE_FPS_EXPR, fps: DENSE_FPS }) {
  const text = String(raw ?? '').trim()
  if (!text) return fallback
  const fraction = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(text)
  if (fraction) {
    const num = Number(fraction[1])
    const den = Number(fraction[2])
    if (num > 0 && den > 0) {
      const fps = num / den
      if (fps >= 0.05 && fps <= 30) return { expr: `${num}/${den}`, fps }
    }
    return fallback
  }
  const plain = Number(text)
  if (Number.isFinite(plain) && plain >= 0.05 && plain <= 30) {
    // 1.2 → "1.2"（ffmpeg 直接认小数）；整数就写成 "2"
    return { expr: String(plain), fps: plain }
  }
  return fallback
}

/** 当前生效的帧率：BILI_DENSE_FPS 优先，否则 6/5（1.2 帧/秒）。 */
export function denseFps() {
  return parseFpsExpr(process.env.BILI_DENSE_FPS)
}

/**
 * 抽帧去重阈值（0 = 不去重）。相邻两帧平均像素差小于它就丢掉后一帧。
 * 画面几乎不动时（聊天、静态演示）能省掉大半帧；有剪辑/大幅变化时照旧全留。
 * 默认 0（保持 2026-10-25 的行为），用 `--dedupe 6` 或 BILI_FRAME_DEDUPE 打开。
 */
export function denseDedupe() {
  const raw = process.env.BILI_FRAME_DEDUPE
  if (raw === undefined || raw === '') return 0
  const num = Number(raw)
  return Number.isFinite(num) && num > 0 ? num : 0
}
/** 抽出来的单帧统一裁成 480×270，和 videoshot 那条路保持一致。 */
const FRAME_W = 480
const FRAME_H = 270
const PYTHON_SCRIPT = `import json, sys
from PIL import Image
job = json.load(open(sys.argv[1], encoding='utf-8'))
for item in job['crops']:
    with Image.open(item['sheet']) as im:
        im.convert('RGB').crop((item['x'], item['y'], item['x'] + item['w'], item['y'] + item['h'])).save(item['out'], 'JPEG', quality=88)
`

// 把一批缩略图裁下来拼成一张联络表：每格上方一行时间戳，单帧保持 480×270 不缩放。
const CONTACT_SCRIPT = `import json, sys
from PIL import Image, ImageDraw, ImageFont
job = json.load(open(sys.argv[1], encoding='utf-8'))
cols = int(job.get('cols', 3))
label_h = int(job.get('labelH', 24))
tiles = job['tiles']
cell_w = int(job['cellW'])
cell_h = int(job['cellH'])
rows = (len(tiles) + cols - 1) // cols
out = Image.new('RGB', (cols * cell_w, rows * (cell_h + label_h)), (250, 250, 250))
draw = ImageDraw.Draw(out)
font = None
for path in (job.get('font'), 'C:/Windows/Fonts/arialbd.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/msyh.ttc'):
    if not path:
        continue
    try:
        font = ImageFont.truetype(path, 18)
        break
    except Exception:
        pass
for i, tile in enumerate(tiles):
    if tile.get('file'):
        crop = Image.open(tile['file']).convert('RGB')
    else:
        with Image.open(tile['sheet']) as im:
            crop = im.convert('RGB').crop((tile['x'], tile['y'], tile['x'] + tile['w'], tile['y'] + tile['h']))
    col = i % cols
    row = i // cols
    x = col * cell_w
    y = row * (cell_h + label_h)
    out.paste(crop, (x, y + label_h))
    draw.text((x + 6, y + 3), tile['label'], fill=(0, 0, 0), font=font)
    draw.rectangle([x, y, x + cell_w - 1, y + cell_h + label_h - 1], outline=(205, 205, 205))
out.save(job['out'], 'JPEG', quality=88)
`

// 相邻帧去重：按顺序算相邻帧的平均像素差，差 < threshold 的丢掉后一帧（画面没变，抽了也白抽）。
const DEDUPE_SCRIPT = `import json, sys
from PIL import Image, ImageChops, ImageStat
job = json.load(open(sys.argv[1], encoding='utf-8'))
thr = float(job['threshold'])
size = (160, 90)
keep = []
prev = None
for path in job['files']:
    with Image.open(path) as im:
        cur = im.convert('L').resize(size)
        if prev is None:
            keep.append(path)
            prev = cur
            continue
        d = ImageStat.Stat(ImageChops.difference(prev, cur)).mean[0]
        if d >= thr:
            keep.append(path)
            prev = cur
print(json.dumps(keep))
`

function clampInt(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.max(min, Math.min(max, Math.round(num)))
}

export function frameTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}:${ss}`
}

/**
 * 精确到 0.1 秒的时间标签（`mm:ss.d`）。
 * 1.2 帧/秒 的间隔是 0.83 秒，只用 mm:ss 会出现两格都写 00:43；
 * 带十分位后每格时间都唯一，Qwen 也能按时间对齐。
 */
export function frameTimePrecise(seconds) {
  const rounded = Math.max(0, Math.round((Number(seconds) || 0) * 10) / 10)
  const mm = String(Math.floor(rounded / 60)).padStart(2, '0')
  const ss = (rounded % 60).toFixed(1).padStart(4, '0')
  return `${mm}:${ss}`
}

/** 每次抽帧一个独立 run 目录：`20261026-204512-abc123`。 */
function newRunId(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`
}

const RUN_DIR_RE = /^\d{8}-\d{6}-[a-z0-9]{4,}$/
const LEGACY_ARTIFACT_RE =
  /^(f-\d+\.jpg|contact-\d+\.jpg|sheet-\d+\.jpg|frame-\d+s\.jpg|_cmp-.*\.jpg|source\.mp4|_job\.json|_dedupe\.json|_contact-.*\.json)$/

/**
 * 清掉旧版本直接写在 `state/frames/<bvid>/` 下的平铺产物。
 * 新版本每次抽帧都写进 run 子目录，互不覆盖；旧的留着只会让人误读。
 */
function clearLegacyArtifacts(base) {
  let names = []
  try {
    names = fs.readdirSync(base)
  } catch {
    return
  }
  for (const name of names) {
    if (!LEGACY_ARTIFACT_RE.test(name)) continue
    try {
      fs.unlinkSync(path.join(base, name))
    } catch {
      /* ignore */
    }
  }
}

/** 同一个 bvid 只留最近 keep 个 run 目录（默认 3），别让 state 无限长。 */
function pruneFrameRuns(base, keep = 3) {
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return
  }
  const runs = entries
    .filter((entry) => entry.isDirectory() && RUN_DIR_RE.test(entry.name))
    .map((entry) => ({ name: entry.name, mtime: fs.statSync(path.join(base, entry.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  for (const run of runs.slice(Math.max(1, keep))) {
    try {
      fs.rmSync(path.join(base, run.name), { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * videoshot 的网格/时间点几何信息（选帧与拼图共用）。
 * @param {object} shot videoshot 返回的 data
 * @param {number} duration 视频时长（秒）
 */
function shotGeometry(shot, duration = 0) {
  const gridX = clampInt(shot.img_x_len, 10, 1, 20)
  const gridY = clampInt(shot.img_y_len, 10, 1, 20)
  const cellW = clampInt(shot.img_x_size, 480, 1, 4096)
  const cellH = clampInt(shot.img_y_size, 270, 1, 4096)
  const perSheet = gridX * gridY
  const sheetCount = Math.max(1, (shot.image || []).length)
  const index = Array.isArray(shot.index) ? shot.index.map(Number).filter((value) => Number.isFinite(value)) : []
  const totalFrames = index.length
    ? Math.min(index.length, perSheet * sheetCount)
    : perSheet * sheetCount
  const scale = index.length && index[index.length - 1] > Math.max(1, duration) * 2 ? 1000 : 1
  return { gridX, gridY, cellW, cellH, perSheet, sheetCount, index, totalFrames, scale }
}

/** 把第 frameIndex 个缩略图映射成裁图坐标 + 时间点。 */
function frameAt(geo, frameIndex, duration = 0) {
  const sheetIndex = Math.floor(frameIndex / geo.perSheet)
  const cell = frameIndex % geo.perSheet
  const x = (cell % geo.gridX) * geo.cellW
  const y = Math.floor(cell / geo.gridX) * geo.cellH
  const at = geo.index.length
    ? Math.round(geo.index[frameIndex] / geo.scale)
    : Math.round((frameIndex * duration) / geo.totalFrames)
  return {
    frameIndex,
    sheetIndex,
    cell,
    x,
    y,
    width: geo.cellW,
    height: geo.cellH,
    at,
    time: frameTime(at),
  }
}

/**
 * 从 videoshot 的 index/网格信息里选 count 帧。
 * @param {{index?:number[], img_x_len?:number, img_y_len?:number, img_x_size?:number, img_y_size?:number, image?:string[]}} shot
 * @param {{count?:number, duration?:number}} opts
 */
export function selectFramePlan(shot, { count = 8, duration = 0 } = {}) {
  const totalRequested = clampInt(count, 8, 1, 12)
  const geo = shotGeometry(shot, duration)
  if (!geo.totalFrames) return []
  // 避开片头/片尾的黑帧：取 5%~90% 区间；只有一帧时取中点。
  const start = geo.totalFrames > 1 ? Math.floor((geo.totalFrames - 1) * 0.05) : 0
  const end = geo.totalFrames > 1 ? Math.floor((geo.totalFrames - 1) * 0.9) : 0
  const positions = []
  for (let i = 0; i < totalRequested; i++) {
    const position =
      totalRequested === 1 ? Math.floor((start + end) / 2) : Math.round(start + (i * (end - start)) / (totalRequested - 1))
    if (!positions.includes(position)) positions.push(position)
  }
  return positions.map((frameIndex) => frameAt(geo, frameIndex, duration))
}

/** 每张联络表的列数/行数：3×3=9 帧，单帧仍是 480×270，拼图不会被压小。 */
export const DENSE_COLS = 3
export const DENSE_ROWS = 3
export const DENSE_PER_SHEET = DENSE_COLS * DENSE_ROWS
/** 一条视频最多取多少帧（= 8 张联络表）；再多 context 和耗时都不划算。 */
export const DENSE_MAX_FRAMES = 72
/** 默认不限制联络表张数（0 = 不限）；--max-sheets N 可手动封顶。 */
export const DEFAULT_MAX_SHEETS = 0

/**
 * 从帧序列里均匀抽 count 个（保留首尾）。长视频按 1.2 帧/秒 会出几十张表，
 * 不抽稀的话 read_image / 本地 Qwen 都看不完，只会变成“看两张就下结论”。
 */
export function sampleFramesEvenly(items, count) {
  if (!Array.isArray(items) || !items.length) return []
  const n = Math.max(1, Math.floor(Number(count) || 0))
  if (items.length <= n) return items.slice()
  if (n === 1) return [items[Math.floor((items.length - 1) / 2)]]
  const out = []
  for (let i = 0; i < n; i++) {
    const item = items[Math.round((i * (items.length - 1)) / (n - 1))]
    if (out[out.length - 1] !== item) out.push(item)
  }
  return out
}

/**
 * 密集模式：用满 videoshot 能给的帧（实测约 20 帧/100 秒），只去掉重复时间点，
 * 超过 maxFrames 时按全片均匀抽稀，而不是截断到前半段。
 * @param {object} shot videoshot 返回的 data
 * @param {{duration?:number, maxFrames?:number}} opts
 */
export function selectDensePlan(shot, { duration = 0, maxFrames = DENSE_MAX_FRAMES } = {}) {
  const geo = shotGeometry(shot, duration)
  if (!geo.totalFrames) return []
  const positions = []
  let lastAt = null
  for (let i = 0; i < geo.totalFrames; i++) {
    const at = frameAt(geo, i, duration).at
    // index 偶尔有重复时间点（例如 [0,0,5]），重复的只留一张
    if (at === lastAt) continue
    positions.push(i)
    lastAt = at
  }
  const cap = clampInt(maxFrames, DENSE_MAX_FRAMES, 1, 200)
  let chosen = positions
  if (positions.length > cap) {
    chosen = []
    for (let i = 0; i < cap; i++) {
      chosen.push(positions[Math.round((i * (positions.length - 1)) / (cap - 1))])
    }
    chosen = [...new Set(chosen)]
  }
  return chosen.map((frameIndex) => frameAt(geo, frameIndex, duration))
}

async function fetchShot(jar, bvid, cid) {
  const url = `https://api.bilibili.com/x/player/videoshot?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&index=1`
  let last = null
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((resolve) => setTimeout(resolve, 800))
    const response = await fetch(url, {
      headers: {
        'User-Agent': DEFAULT_HEADERS['User-Agent'],
        Referer: `${REFERER}video/${bvid}`,
        Cookie: jar.header(),
      },
      signal: AbortSignal.timeout(30_000),
    })
    const data = await response.json()
    if (Number(data.code) !== 0 || !data.data) {
      throw new Error(`videoshot 返回 ${data.code}: ${data.message || ''}`)
    }
    last = data.data
    // index 偶尔会空（接口抖动）；空的时候重试，别退化成 100 个黑格
    if (Array.isArray(data.data.index) && data.data.index.length) return data.data
  }
  return last
}

async function downloadSheet(url, out) {
  const normalized = url.startsWith('//') ? `https:${url}` : url.replace(/^http:/, 'https:')
  const response = await fetch(normalized, {
    headers: {
      'User-Agent': DEFAULT_HEADERS['User-Agent'],
      Referer: REFERER,
    },
    signal: AbortSignal.timeout(60_000),
  })
  const buffer = Buffer.from(await response.arrayBuffer())
  if (!buffer.length) throw new Error('雪碧图下载为空')
  fs.writeFileSync(out, buffer)
  return { url: normalized, bytes: buffer.length }
}

function runPythonScript(script, jobFile) {
  for (const command of [process.env.PYTHON || 'python', 'python3']) {
    const result = spawnSync(command, ['-c', script, jobFile], {
      stdio: 'ignore',
      timeout: 60_000,
      windowsHide: true,
    })
    if (!result.error && result.status === 0) return { ok: true }
  }
  return { ok: false, message: '需要 Python 3 + Pillow 才能裁图' }
}

/**
 * 跑一段 Python 并接住 stdout（去重脚本要回传留下的文件列表）。
 * 同样试 python / python3；失败返回 ok:false，不抛。
 */
function runPythonCapture(script, jobFile) {
  for (const command of [process.env.PYTHON || 'python', 'python3']) {
    const result = spawnSync(command, ['-c', script, jobFile], {
      encoding: 'utf8',
      timeout: 300_000,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    })
    if (!result.error && result.status === 0 && result.stdout) return { ok: true, stdout: result.stdout }
  }
  return { ok: false, message: '去重需要 Python 3 + Pillow' }
}

/**
 * 相邻帧去重：画面几乎没变就把后一帧丢掉。
 * @param {string} dir 抽帧目录
 * @param {string[]} files 排好序的单帧文件名
 * @param {number} threshold 平均像素差阈值（0 = 不去重）
 * @returns {{files:string[], dropped:number, ok:boolean, message?:string}}
 */
function dedupeFrames(dir, files, threshold) {
  if (!(threshold > 0) || files.length < 3) return { ok: true, files, dropped: 0 }
  const jobFile = path.join(dir, '_dedupe.json')
  fs.writeFileSync(
    jobFile,
    JSON.stringify({ threshold, files: files.map((name) => path.join(dir, name)) }),
    'utf8',
  )
  const run = runPythonCapture(DEDUPE_SCRIPT, jobFile)
  try {
    fs.unlinkSync(jobFile)
  } catch {
    /* ignore */
  }
  if (!run.ok) return { ok: false, files, dropped: 0, message: run.message }
  try {
    const kept = JSON.parse(run.stdout)
    if (!Array.isArray(kept) || !kept.length) return { ok: true, files, dropped: 0 }
    const names = kept.map((full) => path.basename(String(full)))
    return { ok: true, files: names, dropped: Math.max(0, files.length - names.length) }
  } catch {
    return { ok: false, files, dropped: 0, message: '去重结果不是合法 JSON' }
  }
}

/** 把一屏 9 帧拼成联络表；tiles 可以是雪碧图裁切，也可以是现成的单帧文件。 */
function writeContactSheet(dir, index, tiles, cellW = FRAME_W, cellH = FRAME_H) {
  const out = path.join(dir, `contact-${String(index).padStart(2, '0')}.jpg`)
  const job = { cols: DENSE_COLS, cellW, cellH, labelH: 24, out, tiles }
  const jobFile = path.join(dir, `_contact-${String(index).padStart(2, '0')}.json`)
  fs.writeFileSync(jobFile, JSON.stringify(job), 'utf8')
  const python = runPythonScript(CONTACT_SCRIPT, jobFile)
  try {
    fs.unlinkSync(jobFile)
  } catch {
    /* ignore */
  }
  if (!python.ok) return { ok: false, message: python.message }
  if (!fs.existsSync(out)) return { ok: false, message: '联络表没有生成' }
  const labels = tiles.map((tile) => tile.label)
  return {
    ok: true,
    sheet: {
      path: out,
      index,
      count: tiles.length,
      from: labels[0],
      to: labels[labels.length - 1],
    },
  }
}

const FFMPEG_CANDIDATES = [
  process.env.FFMPEG,
  path.join(ROOT_DIR, '..', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(ROOT_DIR, '..', '..', '..', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(path.dirname(STATE_DIR), '..', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(os.homedir(), '.dsh', 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
  path.join(ROOT_DIR, 'tools', 'ffmpeg', 'bin', 'ffmpeg.exe'),
]
let ffmpegCache

/** 找 ffmpeg：环境变量 → 工作区 tools/ffmpeg → PATH；找不到返回 null。 */
export function ffmpegPath() {
  if (ffmpegCache !== undefined) return ffmpegCache
  for (const candidate of FFMPEG_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) {
      ffmpegCache = candidate
      return candidate
    }
  }
  const probe = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true })
  ffmpegCache = !probe.error && probe.status === 0 ? 'ffmpeg' : null
  return ffmpegCache
}

/** 拿一个可直接给 ffmpeg 的 mp4 地址（fnval=1 的 durl；没有就退回 dash 视频流）。 */
async function fetchPlayUrl(jar, bvid, cid) {
  let lastError = null
  // 720p 可能因为没登录/没权限被拒，退一档 480p 再试
  for (const qn of [64, 32]) {
    try {
      return await fetchPlayUrlOnce(jar, bvid, cid, qn)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('playurl 失败')
}

async function fetchPlayUrlOnce(jar, bvid, cid, qn) {
  const query = `bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=${qn}&fnval=1&fnver=0&fourk=1&platform=pc&high_quality=1`
  const response = await fetch(`https://api.bilibili.com/x/player/playurl?${query}`, {
    headers: {
      'User-Agent': DEFAULT_HEADERS['User-Agent'],
      Referer: `${REFERER}video/${bvid}`,
      Cookie: jar.header(),
    },
    signal: AbortSignal.timeout(30_000),
  })
  const data = await response.json()
  if (Number(data.code) !== 0 || !data.data) throw new Error(`playurl 返回 ${data.code}: ${data.message || ''}`)
  const payload = data.data
  const durl = Array.isArray(payload.durl) ? payload.durl : []
  if (durl.length > 1) throw new Error('视频被切成多段，暂不支持密集抽帧')
  const direct = durl[0] && (durl[0].url || durl[0].backup_url?.[0])
  if (direct) return direct
  const dash = payload.dash && Array.isArray(payload.dash.video) ? payload.dash.video[0] : null
  const dashUrl = dash && (dash.baseUrl || dash.base_url)
  if (dashUrl) return dashUrl
  throw new Error('playurl 没有可用的视频流')
}

async function downloadToFile(jar, url, out) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': DEFAULT_HEADERS['User-Agent'],
      Referer: REFERER,
      Cookie: jar.header(),
    },
    signal: AbortSignal.timeout(10 * 60_000),
  })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(out))
  const size = fs.statSync(out).size
  if (!size) throw new Error('下载为空')
  return size
}

/**
 * 密集模式（ffmpeg）：下载视频 → 按 fps 抽帧 → 可选去重 → 每 9 张拼联络表。
 * 视频本体只作临时文件，抽完就删。
 * @param {{fpsExpr?:string, fps?:number, dedupe?:number, maxSheets?:number}} opts 默认 6/5（1.2 帧/秒）、不去重、不限表数
 */
async function extractDenseFfmpeg(
  id,
  detail,
  jar,
  dir,
  { fpsExpr, fps, dedupe = 0, maxSheets = DEFAULT_MAX_SHEETS } = {},
) {
  const bin = ffmpegPath()
  if (!bin) return { ok: false, message: '没找到 ffmpeg' }
  const rate = fps && fps > 0 ? fps : DENSE_FPS
  const expr = fpsExpr || DENSE_FPS_EXPR
  let sourceUrl
  try {
    sourceUrl = await fetchPlayUrl(jar, id, detail.cid)
  } catch (error) {
    return { ok: false, message: `拿不到播放地址：${error.message}` }
  }
  const source = path.join(dir, 'source.mp4')
  try {
    await downloadToFile(jar, sourceUrl, source)
  } catch (error) {
    return { ok: false, message: `下载视频失败：${error.message}` }
  }
  // 每次抽帧都在自己的 run 目录里，不需要再清旧帧（旧 run 不会被读到）。
  const pattern = path.join(dir, 'f-%05d.jpg')
  const filter = `fps=${expr},scale=${FRAME_W}:${FRAME_H}:force_original_aspect_ratio=increase,crop=${FRAME_W}:${FRAME_H}`
  const run = spawnSync(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', source, '-vf', filter, '-q:v', '3', pattern], {
    stdio: 'ignore',
    timeout: 20 * 60_000,
    windowsHide: true,
  })
  try {
    fs.unlinkSync(source)
  } catch {
    /* 临时文件，删不掉也不影响 */
  }
  if (run.error || run.status !== 0) {
    return { ok: false, message: `ffmpeg 抽帧失败（${run.error ? run.error.message : `exit ${run.status}`}）` }
  }
  let files = fs
    .readdirSync(dir)
    .filter((name) => /^f-\d+\.jpg$/.test(name))
    .sort()
  if (!files.length) return { ok: false, message: 'ffmpeg 没有产出画面' }
  const totalFrames = files.length
  // 去重：画面几乎没变的后一帧不参与拼图（时间戳仍按原始序号算，不能压缩时间轴）
  const deduped = dedupeFrames(dir, files, dedupe)
  files = deduped.files
  const frames = files.map((name) => {
    const ordinal = Number(/^f-(\d+)\.jpg$/.exec(name)[1]) - 1
    const exact = ordinal / rate
    return { path: path.join(dir, name), at: Math.round(exact), exact, time: frameTimePrecise(exact), ordinal }
  })
  // 长视频全片均匀抽稀：1.2 帧/秒 的 7 分钟视频有 58 张表，read_image/本地 Qwen 都看不完。
  const capFrames = maxSheets > 0 ? maxSheets * DENSE_PER_SHEET : 0
  const frameSource = frames
  const sheetFrames =
    capFrames && frames.length > capFrames ? sampleFramesEvenly(frames, capFrames) : frames
  const sheets = []
  for (let offset = 0; offset < sheetFrames.length; offset += DENSE_PER_SHEET) {
    const chunk = sheetFrames.slice(offset, offset + DENSE_PER_SHEET)
    const built = writeContactSheet(
      dir,
      sheets.length + 1,
      chunk.map((frame) => ({ file: frame.path, label: frame.time })),
    )
    if (!built.ok) return { ok: false, message: built.message }
    sheets.push(built.sheet)
  }
  return {
    ok: true,
    frames: sheetFrames,
    sheets,
    source: 'ffmpeg',
    totalFrames,
    sampledFrom: frameSource.length,
    maxSheets,
    dropped: deduped.dropped || 0,
    fps: rate,
    dedupe: dedupe > 0 ? dedupe : 0,
  }
}

/** 本地 Qwen-VL 看一批图；全失败时给一个错误摘要，但不影响抽帧结果。 */
async function runLocalVision(paths, { kind, count, counts, model, concurrency = 2 }) {
  if (!paths.length) return { vision: [], visionError: null }
  const prompts = Array.isArray(counts) ? counts.map((n) => visionPrompt({ kind, count: n })) : undefined
  const vision = await describeImages(paths, {
    model: model || DEFAULT_VISION_MODEL,
    concurrency,
    ...(prompts ? { prompts } : { prompt: visionPrompt({ kind, count }) }),
  })
  const failed = vision.filter((item) => !item.ok)
  return {
    vision,
    visionError: failed.length === vision.length ? failed[0].message : null,
  }
}

/**
 * 抽帧主入口。
 * - 默认：不管有没有字幕都走密集模式（1.2 帧/秒，有 ffmpeg 时）。
 * - sparse：只有显式 `--sparse` 才抽 1~12 张单图。
 * - vision：默认同时让本地 Qwen-VL 看这些图，返回文字描述给 agent 参考。
 * @param {string} bvid
 * @param {{count?:number, sparse?:boolean, jar?:object, vision?:boolean,
 *   visionModel?:string, visionConcurrency?:number}} opts
 */
export async function extractFrames(
  bvid,
  {
    count = 8,
    sparse = false,
    jar,
    vision = true,
    visionModel = DEFAULT_VISION_MODEL,
    visionConcurrency = 2,
    fps,
    dedupe,
    maxSheets,
  } = {},
) {
  const id = String(bvid || '').trim()
  if (!/^BV[0-9A-Za-z]+$/.test(id)) return { ok: false, message: `bvid 不合法：${bvid}` }
  const ctx = jar ? { jar } : currentContext()
  let detail
  try {
    detail = await videoDetail(ctx.jar, id)
  } catch (error) {
    return { ok: false, message: `拿不到视频详情：${error.message}` }
  }
  if (!detail || !detail.cid) return { ok: false, message: `拿不到 ${id} 的 cid` }
  // 2026-10-25 改成默认密集：识图交给本地 Qwen，DeepSeek 这边只要文字，放心多抽
  const mode = sparse ? 'sparse' : 'dense'
  const subtitle = null
  // 帧率可配（--fps / BILI_DENSE_FPS）；去重阈值可配（--dedupe / BILI_FRAME_DEDUPE）
  const rate = fps === undefined || fps === null || fps === '' ? denseFps() : parseFpsExpr(fps, denseFps())
  const dedupeThreshold = dedupe === undefined || dedupe === null || dedupe === '' ? denseDedupe() : Number(dedupe) || 0
  // 默认不抽稀（DEFAULT_MAX_SHEETS=0）；只有显式 --max-sheets N 才全片均匀抽到 N 张表。
  const sheetCap =
    maxSheets === undefined || maxSheets === null || maxSheets === '' ? DEFAULT_MAX_SHEETS : Number(maxSheets)
  const cappedSheets = Number.isFinite(sheetCap) && sheetCap >= 0 ? Math.floor(sheetCap) : DEFAULT_MAX_SHEETS

  const base = path.join(FRAMES_DIR, id)
  fs.mkdirSync(base, { recursive: true })
  // 每次抽帧独立目录：并发抽同一个视频、或从 0.63 改到 1.2 时，旧表不会混进新结果。
  clearLegacyArtifacts(base)
  const dir = path.join(base, newRunId())
  fs.mkdirSync(dir, { recursive: true })
  // 先建新目录再 prune，才是「保留最近 3 个」（含本次）。
  pruneFrameRuns(base, 3)

  // 密集模式优先 ffmpeg（默认 1.2 帧/秒）；没有 ffmpeg 就退回 videoshot 能给的帧。
  let ffmpegError = null
  if (mode === 'dense') {
    const attempt = await extractDenseFfmpeg(id, detail, ctx.jar, dir, {
      fpsExpr: rate.expr,
      fps: rate.fps,
      dedupe: dedupeThreshold,
      maxSheets: cappedSheets,
    })
    if (attempt.ok) {
      const local = vision
        ? await runLocalVision(
            attempt.sheets.map((sheet) => sheet.path),
            {
              kind: 'contact',
              count: DENSE_PER_SHEET,
              counts: attempt.sheets.map((sheet) => sheet.count),
              model: visionModel,
              concurrency: visionConcurrency,
            },
          )
        : { vision: [], visionError: null }
      const perSecond = Math.round(rate.fps * 10) / 10
      return {
        ok: true,
        bvid: id,
        title: detail.title,
        duration: detail.duration,
        mode: 'dense',
        source: 'ffmpeg',
        subtitle,
        count: attempt.frames.length,
        totalFrames: attempt.totalFrames,
        sampledFrom: attempt.sampledFrom,
        sampled: attempt.sampledFrom > attempt.frames.length,
        maxSheets: cappedSheets,
        dropped: attempt.dropped,
        fps: attempt.fps,
        dedupe: attempt.dedupe,
        sheets: attempt.sheets,
        vision: local.vision,
        visionError: local.visionError,
        dir,
        hint:
          `按 ${perSecond} 帧/秒（约每 ${(1 / rate.fps).toFixed(2)} 秒一格）拼成联络表：每张 3×3、每格左上角是 mm:ss.d（十分之一秒），` +
          (attempt.sampledFrom > attempt.frames.length
            ? `原片 ${attempt.sampledFrom} 帧，已全片均匀抽到 ${attempt.frames.length} 帧 / ${attempt.sheets.length} 张表（想更密用 --max-sheets 0）；`
            : '') +
          '请按顺序 read_image 看；vision 是本地 Qwen 的对照；不同表之间按时间先后接。' +
          (attempt.dropped ? `（画面没变的后一帧已跳过 ${attempt.dropped} 张）` : ''),
      }
    }
    ffmpegError = attempt.message
  }

  let shot
  try {
    shot = await fetchShot(ctx.jar, id, detail.cid)
  } catch (error) {
    return { ok: false, message: `拿不到视频缩略图：${error.message}`, subtitle }
  }

  const plan =
    mode === 'dense'
      ? selectDensePlan(shot, {
          duration: detail.duration,
          maxFrames: cappedSheets > 0 ? Math.min(200, cappedSheets * DENSE_PER_SHEET) : 200,
        })
      : selectFramePlan(shot, { count, duration: detail.duration })
  if (!plan.length) return { ok: false, message: '没有可用的缩略图', subtitle }
  if (!Array.isArray(shot.index) || !shot.index.length) {
    return { ok: false, message: 'videoshot 没返回时间点，先不看画面（避免抽到黑格）', subtitle }
  }

  const sheets = shot.image || []
  const sheetFiles = new Map()
  for (const frame of plan) {
    if (sheetFiles.has(frame.sheetIndex)) continue
    const source = sheets[frame.sheetIndex]
    if (!source) return { ok: false, message: `缺少第 ${frame.sheetIndex + 1} 张雪碧图`, subtitle }
    const file = path.join(dir, `sheet-${frame.sheetIndex + 1}.jpg`)
    try {
      await downloadSheet(source, file)
      sheetFiles.set(frame.sheetIndex, file)
    } catch (error) {
      return { ok: false, message: `雪碧图下载失败：${error.message}`, subtitle }
    }
  }

  if (mode === 'dense') {
    const contactSheets = []
    for (let offset = 0; offset < plan.length; offset += DENSE_PER_SHEET) {
      const chunk = plan.slice(offset, offset + DENSE_PER_SHEET)
      const tiles = chunk.map((frame) => ({
        sheet: sheetFiles.get(frame.sheetIndex),
        x: frame.x,
        y: frame.y,
        w: frame.width,
        h: frame.height,
        label: frame.time,
      }))
      const built = writeContactSheet(dir, contactSheets.length + 1, tiles)
      if (!built.ok) return { ok: false, message: built.message, dir, subtitle }
      contactSheets.push(built.sheet)
    }
    const local = vision
      ? await runLocalVision(
          contactSheets.map((sheet) => sheet.path),
          {
            kind: 'contact',
            count: DENSE_PER_SHEET,
            counts: contactSheets.map((sheet) => sheet.count),
            model: visionModel,
            concurrency: visionConcurrency,
          },
        )
      : { vision: [], visionError: null }
    return {
      ok: true,
      bvid: id,
      title: detail.title,
      duration: detail.duration,
      mode: 'dense',
      source: 'videoshot',
      subtitle,
      count: plan.length,
      maxSheets: cappedSheets,
      sampled: false,
      sheets: contactSheets,
      vision: local.vision,
      visionError: local.visionError,
      dir,
      ffmpegError,
      hint:
        `没有 ffmpeg，只能用 videoshot 能给的 ${plan.length} 帧（约 20 帧/100 秒，达不到默认的 1.2 帧/秒）拼联络表：` +
        '每张 3×3、每格左上角是 mm:ss，按顺序 read_image 看；vision 是本地 Qwen 的对照。',
    }
  }

  const crops = plan.map((frame) => ({
    sheet: sheetFiles.get(frame.sheetIndex),
    out: path.join(dir, `frame-${String(frame.at).padStart(4, '0')}s.jpg`),
    x: frame.x,
    y: frame.y,
    w: frame.width,
    h: frame.height,
  }))
  const jobFile = path.join(dir, '_job.json')
  fs.writeFileSync(jobFile, JSON.stringify({ crops }), 'utf8')
  const python = runPythonScript(PYTHON_SCRIPT, jobFile)
  try {
    fs.unlinkSync(jobFile)
  } catch {
    /* ignore */
  }
  if (!python.ok) return { ok: false, message: python.message, dir }
  const frames = plan.map((frame, index) => ({
    at: frame.at,
    time: frame.time,
    path: crops[index].out,
    sheet: frame.sheetIndex + 1,
    x: frame.x,
    y: frame.y,
    width: frame.width,
    height: frame.height,
  }))
  const missing = frames.filter((frame) => !fs.existsSync(frame.path))
  if (missing.length) return { ok: false, message: `${missing.length} 张裁图没生成`, frames, dir }
  const local = vision
    ? await runLocalVision(
        frames.map((frame) => frame.path),
        { kind: 'frame', count: frames.length, model: visionModel, concurrency: visionConcurrency },
      )
    : { vision: [], visionError: null }
  return {
    ok: true,
    bvid: id,
    title: detail.title,
    duration: detail.duration,
    mode: 'sparse',
    subtitle,
    count: frames.length,
    frames,
    vision: local.vision,
    visionError: local.visionError,
    dir,
    hint: '用 read_image 看这些 path（DeepSeek 能看图）；vision 是本地 Qwen 的对照；每场最多挑 2 个视频，每个 3~4 张。',
  }
}

/** 一次抽帧的元数据（不含识图结果）：`meta.json`，给 --vision-only / --vision-status 用。 */
export const RUN_META_FILE = 'meta.json'
/** 识图结果（可增量写入）：`vision.json`。 */
export const VISION_FILE = 'vision.json'

export function writeRunMeta(dir, result) {
  const meta = {
    bvid: result.bvid,
    title: result.title,
    duration: result.duration,
    mode: result.mode,
    source: result.source,
    fps: result.fps,
    count: result.count,
    totalFrames: result.totalFrames,
    sampledFrom: result.sampledFrom,
    sampled: result.sampled,
    maxSheets: result.maxSheets,
    sheets: (result.sheets || []).map((sheet) => ({
      index: sheet.index,
      path: sheet.path,
      count: sheet.count,
      from: sheet.from,
      to: sheet.to,
    })),
    frames: (result.frames || []).map((frame) => ({ path: frame.path, time: frame.time, at: frame.at })),
    dir,
    createdAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(dir, RUN_META_FILE), JSON.stringify(meta, null, 2), 'utf8')
  return meta
}

export function readRunMeta(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, RUN_META_FILE), 'utf8'))
  } catch {
    return null
  }
}

export function readVisionState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, VISION_FILE), 'utf8'))
  } catch {
    return { dir, total: 0, items: {} }
  }
}

function saveVisionState(dir, state, jsonOut) {
  const out = jsonOut || path.join(dir, VISION_FILE)
  fs.writeFileSync(out, JSON.stringify(state, null, 2), 'utf8')
  return out
}

/** 找某个 bvid 最近一次抽帧的 run 目录（优先带 meta.json 的）。 */
export function latestFrameRunDir(bvid) {
  const id = String(bvid || '').trim()
  if (!/^BV[0-9A-Za-z]+$/.test(id)) return null
  const base = path.join(FRAMES_DIR, id)
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return null
  }
  const runs = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_DIR_RE.test(entry.name)) continue
    const full = path.join(base, entry.name)
    let mtime = 0
    try {
      mtime = fs.statSync(full).mtimeMs
    } catch {
      continue
    }
    runs.push({ full, mtime })
  }
  runs.sort((a, b) => b.mtime - a.mtime)
  return runs[0]?.full || null
}

/** 把 meta 里的联络表/单帧统一成识图目标。 */
function metaTargets(meta) {
  if (!meta) return []
  if (Array.isArray(meta.sheets) && meta.sheets.length) {
    return meta.sheets.map((sheet) => ({
      key: String(sheet.index),
      file: sheet.path,
      count: Number(sheet.count) || DENSE_PER_SHEET,
      kind: 'contact',
      label: `表 ${sheet.index}`,
    }))
  }
  if (Array.isArray(meta.frames) && meta.frames.length) {
    return meta.frames.map((frame, i) => ({
      key: String(i + 1),
      file: frame.path,
      count: 1,
      kind: 'frame',
      label: frame.time || `第 ${i + 1} 张`,
    }))
  }
  return []
}

/**
 * 对已有 run 目录做本地识图，默认每次最多 2 张（单张 12~100 秒，2 张能压进 300s 终端）。
 * 结果增量写进 `vision.json`，中断后重跑会跳过已成功的表。
 * @param {string} dir run 目录
 * @param {{limit?:number, model?:string, jsonOut?:string, describe?:Function}} opts
 */
export async function runVisionForRun(
  dir,
  { limit = 2, model = DEFAULT_VISION_MODEL, jsonOut, describe = describeImage, timeoutMs = 120_000 } = {},
) {
  const meta = readRunMeta(dir)
  if (!meta) return { ok: false, message: `${dir} 里没有 meta.json，先跑 frames --bvid ... --no-vision` }
  const targets = metaTargets(meta)
  if (!targets.length) return { ok: false, message: `${dir} 里没有可识图的联络表/单帧` }
  const state = readVisionState(dir)
  state.dir = dir
  state.bvid = meta.bvid || state.bvid
  state.total = targets.length
  state.items = state.items && typeof state.items === 'object' ? state.items : {}
  const pending = targets.filter((target) => !(state.items[target.key] && state.items[target.key].ok))
  const wanted = Number(limit)
  const take = Math.max(0, Math.min(Number.isFinite(wanted) && wanted >= 0 ? wanted : 5, pending.length))
  for (const target of pending.slice(0, take)) {
    const started = Date.now()
    try {
      const text = await describe(target.file, {
        model,
        prompt: visionPrompt({ kind: target.kind, count: target.count }),
        timeoutMs,
      })
      state.items[target.key] = {
        ok: true,
        file: target.file,
        index: Number(target.key),
        count: target.count,
        label: target.label,
        text,
        ms: Date.now() - started,
      }
    } catch (error) {
      state.items[target.key] = {
        ok: false,
        file: target.file,
        index: Number(target.key),
        count: target.count,
        label: target.label,
        message: error.message,
        ms: Date.now() - started,
      }
    }
    state.updatedAt = new Date().toISOString()
    saveVisionState(dir, state, jsonOut)
  }
  const outFile = saveVisionState(dir, state, jsonOut)
  const items = targets.map((target) => state.items[target.key]).filter(Boolean)
  const done = items.filter((item) => item.ok).length
  return {
    ok: true,
    dir,
    outFile,
    total: targets.length,
    done,
    remaining: Math.max(0, targets.length - done),
    processed: take,
    items,
  }
}

/** 读进度 + 已完成的识图文本（不跑模型）。 */
export function visionStatusForRun(dir, { jsonOut } = {}) {
  const meta = readRunMeta(dir)
  const state = readVisionState(dir)
  const targets = metaTargets(meta)
  const total = targets.length || state.total || 0
  const items = targets.length
    ? targets.map((target) => state.items && state.items[target.key]).filter((item) => item && item.ok)
    : Object.values(state.items || {}).filter((item) => item && item.ok)
  items.sort((a, b) => Number(a.index) - Number(b.index))
  const text = items.map((item) => `【${item.label || `表 ${item.index}`}】\n${item.text}`).join('\n\n')
  return {
    ok: true,
    dir,
    outFile: jsonOut || path.join(dir, VISION_FILE),
    total,
    done: items.length,
    remaining: Math.max(0, total - items.length),
    text,
    items,
  }
}

/**
 * 注意：不要在 CLI 里 spawn「detached 后台识图」。
 * 本机 DSH 终端跑在 Windows job object 里，命令一结束所有子进程都会被回收（实测 detached + unref 也活不过 2 秒）。
 * 要后台跑就让终端工具自己跑（run_in_background / 后台任务）；否则用 `--limit 2` 分批，每批 <300s。
 */

/** 抽帧图片保留天数：默认 1 天；BILI_FRAME_KEEP_DAYS 可覆盖（最小 1）。 */
export function frameKeepDays() {
  const value = Number(process.env.BILI_FRAME_KEEP_DAYS)
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1
}

/** 清掉超过 days 天的抽帧文件（run 目录 / 旧平铺文件都算）；默认 1 天。 */
export function cleanupFrames(days = frameKeepDays()) {
  try {
    const keep = Number.isFinite(Number(days)) && Number(days) >= 1 ? Math.floor(Number(days)) : frameKeepDays()
    const cutoff = Date.now() - keep * 86400_000
    for (const entry of fs.readdirSync(FRAMES_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const bvidDir = path.join(FRAMES_DIR, entry.name)
      let remaining = 0
      for (const child of fs.readdirSync(bvidDir, { withFileTypes: true })) {
        const full = path.join(bvidDir, child.name)
        let mtime = 0
        try {
          mtime = fs.statSync(full).mtimeMs
        } catch {
          continue
        }
        if (mtime >= cutoff) {
          remaining += 1
          continue
        }
        if (child.isDirectory()) fs.rmSync(full, { recursive: true, force: true })
        else fs.unlinkSync(full)
      }
      if (!remaining) fs.rmSync(bvidDir, { recursive: true, force: true })
    }
  } catch {
    /* ignore */
  }
}
