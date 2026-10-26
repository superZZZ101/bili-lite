// src/state.mjs — 本地状态（state/state.json）读写：默认值、原子保存、便捷更新
// 说明：state/ 与 reports/ 是运行时目录，不进版本库；读取失败一律回退默认状态。
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '..')
// BILI_LITE_HOME 允许把运行时数据挪到可写目录（例如 DSH 的 workspace-write 沙箱下，
// 全局安装的 skill 目录本身不可写，就把 HOME 指到当前工作区）。
const HOME = process.env.BILI_LITE_HOME ? path.resolve(process.env.BILI_LITE_HOME) : ROOT

export const STATE_DIR = path.join(HOME, 'state')
export const STATE_FILE = path.join(STATE_DIR, 'state.json')
export const REPORTS_DIR = path.join(HOME, 'reports')

/** 默认配置：默认 dryRun，宁可少发也不误发 */
export function defaultConfig() {
  return {
    personaPath: '',
    personaText: '',
    targetUid: 0,
    dailyLimit: 2,
    dryRun: true,
    minDuration: 60,
    maxDuration: 1800,
    // 定时任务相关：autoSend=false 时自动轮只预览不发送；scheduleSkipChance 是当天跳过的概率
    autoSend: false,
    scheduleSkipChance: 0,
    // 账号互动：默认全关；投币还要花硬币，改名完成前不要开
    autoLike: false,
    autoFav: false,
    autoFollow: false,
    autoCoin: false,
    favFolderName: 'bili-lite',
    // 点评与私信：dmReview=true 时私信会带点评；提示词可用文件/内联覆盖
    dmReview: true,
    reviewPromptPath: '',
    reviewPromptText: '',
    // 日记写法（默认跟 review.md 同目录的 diary.md；也可单独指一个文件）
    diaryPromptPath: '',
    // 点评长度上限（字）：B 站私信单条 500 字符，长点评会自动拆成多条发送
    reviewMaxChars: 480,
    // 实时监听私信的轮询间隔（秒）
    watchInterval: 60,
    // 陌生人私信：默认允许回复，但每天最多 3 条（防止被当骚扰/刷量）
    replyStrangers: true,
    // 会话切换（2026-10-26）：默认只按天换会话——同一个对话一直用到跨天。
    // 0 = 关闭这一项；想恢复「上下文到 N 字符 / 满 N 轮就换新 sessionId」就设成 >0（如 6 / 50000）。
    sessionResetRounds: 0,
    sessionResetChars: 0,
    // 重置包里每本日记最多带多少字符（两本都带，控制首轮 token）
    diaryPackChars: 2600,
    // 她自己的生活（2026-10-24）：低谷期每小时一件小事，动作看心情
    lifeEnabled: true,
    lifeScanLimit: 8,
    dynamicDailyCap: 3,
    proactiveDailyCap: 10,
    memoryKeepRatio: 0.63,
    // 旧的“每日推荐”自动轮已停用；保留手动 scan/send
    autoRecommendations: false,
  }
}

/** 完整默认状态（与 SPEC 数据模型一致） */
export function defaultState() {
  return {
    version: 1,
    config: defaultConfig(),
    cookies: null,
    seen: {},
    candidates: [],
    picks: [],
    lastScanAt: '',
    lastSendAt: '',
    inboxAckTs: 0,
  }
}

function toNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 把任意来源的对象补全成合法 State（缺字段/类型不对都兜底） */
function normalizeState(raw) {
  const base = defaultState()
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base

  const rawConfig = raw.config && typeof raw.config === 'object' ? raw.config : {}
  const config = {
    ...base.config,
    ...rawConfig,
    personaPath: typeof rawConfig.personaPath === 'string' ? rawConfig.personaPath : base.config.personaPath,
    personaText: typeof rawConfig.personaText === 'string' ? rawConfig.personaText : base.config.personaText,
    targetUid: toNumber(rawConfig.targetUid, base.config.targetUid),
    dailyLimit: Math.max(0, toNumber(rawConfig.dailyLimit, base.config.dailyLimit)),
    dryRun: rawConfig.dryRun !== false,
    minDuration: Math.max(0, toNumber(rawConfig.minDuration, base.config.minDuration)),
    maxDuration: Math.max(0, toNumber(rawConfig.maxDuration, base.config.maxDuration)),
  }

  return {
    ...base,
    ...raw,
    version: 1,
    config,
    cookies: raw.cookies && typeof raw.cookies === 'object' && !Array.isArray(raw.cookies) ? raw.cookies : null,
    seen: raw.seen && typeof raw.seen === 'object' && !Array.isArray(raw.seen) ? raw.seen : {},
    candidates: Array.isArray(raw.candidates) ? raw.candidates : [],
    picks: Array.isArray(raw.picks) ? raw.picks : [],
    lastScanAt: typeof raw.lastScanAt === 'string' ? raw.lastScanAt : '',
    lastSendAt: typeof raw.lastSendAt === 'string' ? raw.lastSendAt : '',
    inboxAckTs: toNumber(raw.inboxAckTs, 0),
  }
}

/** 创建 state/ 与 reports/（幂等） */
export function ensureDirs() {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
}

/** 读取状态；文件不存在、为空或 JSON 损坏时返回默认状态（不抛错） */
export function loadState() {
  try {
    const text = fs.readFileSync(STATE_FILE, 'utf8')
    if (!text.trim()) return defaultState()
    return normalizeState(JSON.parse(text))
  } catch {
    return defaultState()
  }
}

/**
 * 保存状态：先写同目录临时文件再原子 rename，避免并发/中断把 state.json 写坏。
 * @param {object} state
 * @returns {object} 实际落盘的规范化状态
 */
export function saveState(state) {
  ensureDirs()
  const normalized = normalizeState(state)
  const tmpFile = `${STATE_FILE}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpFile, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmpFile, STATE_FILE)
  } catch (error) {
    try {
      fs.unlinkSync(tmpFile)
    } catch {
      /* 清理失败忽略 */
    }
    throw error
  }
  return normalized
}

/**
 * 读-改-写便捷函数：mutator 可以原地修改 state，也可以返回新对象。
 * @param {(state: object) => object | void} mutator
 */
export function updateState(mutator) {
  const state = loadState()
  const result = typeof mutator === 'function' ? mutator(state) : state
  return saveState(result && typeof result === 'object' ? result : state)
}

/** 读取当前配置（已与默认值合并） */
export function cfg() {
  return loadState().config
}
