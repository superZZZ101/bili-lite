// test/session.test.mjs — 会话重置（6 轮 / 50K 字符）+ 首轮注入人设与两本日记
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  buildMemoryPack,
  buildTurn,
  decideTurn,
  decodeSessionLog,
  inspectSession,
  loadSessions,
  markReset,
  measureEvents,
  resetCardLines,
  saveSessions,
} from '../src/session.mjs'
import { appendEntry } from '../src/diary.mjs'

function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-session-'))
  test.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return {
    root,
    sessionsRoot: path.join(root, 'sessions'),
    stateFile: path.join(root, 'dm-sessions.json'),
    diaryDir: path.join(root, 'diary'),
  }
}

function writeSession(sessionsRoot, sessionId, events, workspace = '--ws--') {
  const dir = path.join(sessionsRoot, workspace, sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const frames = events.map((event) =>
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`, 'utf8')),
  )
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return dir
}

function turnEvents(count, { user = 100, assistant = 50, result = 20 } = {}) {
  const events = []
  for (let i = 0; i < count; i++) {
    events.push({ type: 'turn/start', time: 1_700_000_000_000 + i })
    events.push({ type: 'user/message', data: { content: [{ type: 'text', text: 'u'.repeat(user) }] } })
    events.push({
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'a'.repeat(assistant) }] } },
    })
    events.push({
      type: 'tool/result',
      data: { message: { content: [{ type: 'text', text: 'r'.repeat(result) }] } },
    })
  }
  return events
}

function record(env, key, sessionId, epoch = 1, extra = {}) {
  // 真实记录里 base 是去掉 -eN 的会话基名（如 bili-lite-dm），不是带 epoch 的 id
  const base = String(sessionId).replace(/-e\d+$/, '')
  saveSessions(
    { version: 1, sessions: { [key]: { sessionId, epoch, base, createdAt: new Date().toISOString(), ...extra } } },
    { stateFile: env.stateFile },
  )
}

test('resetCardLines：阈值显式给了就写阈值；默认 0 = 一天一个对话', () => {
  const lines = resetCardLines({ rounds: 6, chars: 50000 })
  assert.equal(lines.length, 2)
  assert.match(lines[0], /50K 字符/)
  assert.match(lines[0], /每 6 轮/)
  assert.match(lines[1], /只在会话首轮注入 review\.md/)
  assert.match(resetCardLines({ rounds: 5, chars: 20000 })[0], /20K 字符.*5 轮/)
  // 默认（0 / 0）：不提阈值，写「按天切换」
  assert.match(resetCardLines()[0], /按天切换/)
  assert.doesNotMatch(resetCardLines()[0], /K 字符|每 \d+ 轮/)
})

test('measureEvents：只算会重发的对话/工具内容，不算 reasoning 和 system', () => {
  const events = [
    { type: 'turn/start' },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'u'.repeat(10) }] } },
    {
      type: 'assistant/message',
      data: {
        message: {
          content: [
            { type: 'reasoning', text: 'r'.repeat(999) },
            { type: 'text', text: 'a'.repeat(5) },
            { type: 'tool-call', name: 'x', arguments: '{}' },
          ],
        },
      },
    },
    { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 't'.repeat(7) }] } } },
    { type: 'system/message', data: { message: { content: [{ type: 'text', text: 's'.repeat(1000) }] } } },
  ]
  const measured = measureEvents(events)
  assert.equal(measured.turns, 1)
  // 10 + 5 + JSON(tool-call) + 7；reasoning/system 不计
  assert.ok(measured.contextChars > 22)
  assert.ok(measured.contextChars < 100)
})

test('inspectSession：从 zstd 会话日志读轮数与上下文字符', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(3))
  const info = inspectSession('bili-lite-dm', { sessionsRoot: env.sessionsRoot })
  assert.equal(info.exists, true)
  assert.equal(info.turns, 3)
  assert.equal(info.contextChars, 3 * (100 + 50 + 20))
})

test('decodeSessionLog：兼容未压缩的 .jsonl', () => {
  const env = tempEnv()
  const dir = path.join(env.sessionsRoot, '--ws--', 'plain')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'turn/start' })}\n`)
  const info = inspectSession('plain', { sessionsRoot: env.sessionsRoot })
  assert.equal(info.exists, true)
  assert.equal(info.turns, 1)
})

test('decideTurn：没有记录也没有日志 → 新会话，首轮重置', () => {
  const env = tempEnv()
  const turn = decideTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    writeState: true,
  })
  assert.equal(turn.reset, true)
  assert.equal(turn.reason, 'new')
  assert.equal(turn.epoch, 1)
  assert.equal(turn.sessionId, 'bili-lite-dm')
  const saved = loadSessions({ stateFile: env.stateFile })
  assert.equal(saved.sessions.owner.sessionId, 'bili-lite-dm')
})

test('decideTurn：base 日期变了（跨天）→ 开新会话，不复用昨天的', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm-20261024', turnEvents(1))
  record(env, 'owner', 'bili-lite-dm-20261024', 1)
  const turn = decideTurn({
    key: 'owner',
    base: 'bili-lite-dm-20261025',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    writeState: true,
  })
  assert.equal(turn.reset, true)
  assert.equal(turn.reason, 'daily')
  assert.equal(turn.sessionId, 'bili-lite-dm-20261025')
  assert.equal(loadSessions({ stateFile: env.stateFile }).sessions.owner.base, 'bili-lite-dm-20261025')
})

test('decideTurn：满 6 轮换新 sessionId（阈值显式给 6 轮时）', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(6))
  record(env, 'owner', 'bili-lite-dm', 1)
  const turn = decideTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    limits: { rounds: 6, chars: 0 },
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    writeState: true,
  })
  assert.equal(turn.reset, true)
  assert.equal(turn.reason, 'rounds')
  assert.equal(turn.epoch, 2)
  assert.equal(turn.sessionId, 'bili-lite-dm-e2')
  assert.equal(loadSessions({ stateFile: env.stateFile }).sessions.owner.sessionId, 'bili-lite-dm-e2')
})

test('decideTurn：默认阈值 0 = 关掉「到多少上下文就切对话」，30 轮也还是同一个会话', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(30, { user: 4000, assistant: 3000, result: 3000 }))
  record(env, 'owner', 'bili-lite-dm', 1)
  const turn = decideTurn({ key: 'owner', base: 'bili-lite-dm', sessionsRoot: env.sessionsRoot, stateFile: env.stateFile })
  assert.equal(turn.reset, false)
  assert.equal(turn.reason, '')
  assert.equal(turn.sessionId, 'bili-lite-dm')
  assert.ok(turn.contextChars > 100_000, '上下文早就超过旧的 50K 阈值了')
  // 一天一个对话：只有 base 带日期变了（跨天）才换
  const nextDay = decideTurn({
    key: 'owner',
    base: 'bili-lite-dm-20261026',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    writeState: true,
  })
  assert.equal(nextDay.reset, true)
  assert.equal(nextDay.reason, 'daily')
  assert.equal(nextDay.sessionId, 'bili-lite-dm-20261026')
})

test('decideTurn：上下文到 50K 也重置（阈值可配）', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(2, { user: 400, assistant: 300, result: 300 }))
  record(env, 'owner', 'bili-lite-dm', 1)
  const turn = decideTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    limits: { rounds: 6, chars: 1000 },
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
  })
  assert.equal(turn.reset, true)
  assert.equal(turn.reason, 'chars')
  assert.equal(turn.turns, 2)
  assert.ok(turn.contextChars >= 1000)
})

test('decideTurn：没到阈值就继续用同一个会话，且不写盘', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(3))
  record(env, 'owner', 'bili-lite-dm', 1)
  const before = fs.statSync(env.stateFile).mtimeMs
  const turn = decideTurn({ key: 'owner', base: 'bili-lite-dm', sessionsRoot: env.sessionsRoot, stateFile: env.stateFile })
  assert.equal(turn.reset, false)
  assert.equal(turn.sessionId, 'bili-lite-dm')
  assert.equal(turn.turns, 3)
  assert.equal(fs.statSync(env.stateFile).mtimeMs, before)
})

test('decideTurn：日志丢了 → 重新注入同一个 id；已手动 reset → 换新 id', () => {
  const env = tempEnv()
  record(env, 'owner', 'bili-lite-dm-e2', 2)
  const missing = decideTurn({ key: 'owner', base: 'bili-lite-dm', sessionsRoot: env.sessionsRoot, stateFile: env.stateFile })
  assert.equal(missing.reason, 'missing')
  assert.equal(missing.sessionId, 'bili-lite-dm-e2', '空会话复用同一个 id，避免多一个空会话')

  writeSession(env.sessionsRoot, 'bili-lite-dm-e2', turnEvents(2))
  markReset('owner', { stateFile: env.stateFile, base: 'bili-lite-dm' })
  const manual = decideTurn({ key: 'owner', base: 'bili-lite-dm', sessionsRoot: env.sessionsRoot, stateFile: env.stateFile, writeState: true })
  assert.equal(manual.reason, 'manual')
  assert.equal(manual.epoch, 3)
  assert.equal(manual.sessionId, 'bili-lite-dm-e3')
  assert.equal(loadSessions({ stateFile: env.stateFile }).sessions.owner.forceReset, undefined)
})

test('decideTurn：升级前的老会话（有 13 轮、无记录）自动换到 e2', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(13))
  const turn = decideTurn({ key: 'owner', base: 'bili-lite-dm', sessionsRoot: env.sessionsRoot, stateFile: env.stateFile, writeState: true })
  assert.equal(turn.reason, 'legacy')
  assert.equal(turn.sessionId, 'bili-lite-dm-e2')
})

test('buildTurn：普通轮只发新消息 + 一句风格，不重发人设/私密日记', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(3))
  record(env, 'owner', 'bili-lite-dm', 1)
  appendEntry('private', { text: 'PRIVATE_SECRET', dir: env.diaryDir })
  const turn = buildTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER', diaryPackChars: 800 },
    messages: [{ text: '主人问你今天刷到什么' }],
    cli: 'C:/fake/cli.mjs',
  })
  assert.equal(turn.reset, false)
  assert.equal(turn.sessionId, 'bili-lite-dm')
  assert.match(turn.prompt, /主人问你今天刷到什么/)
  assert.match(turn.prompt, /按 prompts\/review\.md 的风格/)
  assert.doesNotMatch(turn.prompt, /PERSONA_MARKER/)
  assert.doesNotMatch(turn.prompt, /PRIVATE_SECRET/)
  assert.doesNotMatch(turn.prompt, /【这次有图/)
})

test('buildTurn：普通轮把稳定指令放前面、新消息和变动的心情放最后（照顾前缀缓存）', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(3))
  record(env, 'owner', 'bili-lite-dm', 1)
  const turn = buildTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER' },
    messages: [{ text: 'CACHE_MSG' }],
    cli: 'C:/fake/cli.mjs',
  })
  const envIndex = turn.prompt.indexOf('【环境】')
  const msgIndex = turn.prompt.indexOf('CACHE_MSG')
  const moodIndex = turn.prompt.indexOf('【现在的心情】')
  assert.ok(envIndex >= 0 && envIndex < msgIndex, '环境指令在新消息之前')
  assert.ok(msgIndex < moodIndex, '新消息在心情之前')
})

test('buildTurn：主人发图时注入四步看图法（识图→复述→有趣的地方→人家自己的看法）', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(3))
  record(env, 'owner', 'bili-lite-dm', 1)
  const turn = buildTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER' },
    messages: [{ text: '[图片]', localPath: 'C:/tmp/meme.png' }],
    cli: 'C:/fake/cli.mjs',
  })
  assert.match(turn.prompt, /【这次有图 · 按四步看懂再回】/)
  assert.match(turn.prompt, /1\. 识图/)
  assert.match(turn.prompt, /多格图从第一格看到最后一格/)
  assert.match(turn.prompt, /逐字认图里的文字/)
  assert.match(turn.prompt, /2\. 复述/)
  assert.match(turn.prompt, /可以极简一句带过，也可以不说/)
  assert.match(turn.prompt, /3\. 有趣的地方/)
  assert.match(turn.prompt, /这一层必须有/)
  assert.match(turn.prompt, /4\. 人家自己的看法/)
  assert.match(turn.prompt, /不是当旁观者解说画面/)
  // 不分段，但后两层必须都在
  assert.match(turn.prompt, /不用按 1~4 分段/)
  // DeepSeek 拟人图要认出来（蓝鲸娘本家）
  assert.match(turn.prompt, /DeepSeek 拟人图要一眼认出来/)
  assert.match(turn.prompt, /蓝白女仆装/)
  assert.match(turn.prompt, /别当普通二次元头像/)
  assert.match(turn.prompt, /只是撞色就说不确定/)
  assert.match(turn.prompt, /发送前自查/)
  assert.match(turn.prompt, /别说成主人做的/)
})

test('buildTurn：带本地识图的私信图片会把 Qwen-VL 描述放进 prompt', () => {
  const env = tempEnv()
  const turn = buildTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER' },
    messages: [
      { text: '[图片]', localPath: 'C:/tmp/meme.png', visionText: '图里是一只橘猫，屏幕文字“笑死”' },
    ],
    cli: 'C:/fake/cli.mjs',
  })
  assert.match(turn.prompt, /本地识图参考（Qwen-VL 看到的就是这些）/)
  assert.match(turn.prompt, /图里是一只橘猫/)
  assert.match(turn.prompt, /先用 read_image 看原图/)
  assert.match(turn.prompt, /本地识图参考.*做对照/)
})

test('buildTurn：陌生人发图也注入看图步骤，用对方而不是主人', () => {
  const env = tempEnv()
  const turn = buildTurn({
    key: 'u42',
    base: 'bili-lite-dm-u42',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER' },
    sender: { uid: 42, uname: '路人' },
    messages: [{ text: '[图片]', localPath: 'C:/tmp/meme.png' }],
    cli: 'C:/fake/cli.mjs',
  })
  assert.match(turn.prompt, /【这次有图 · 按四步看懂再回】/)
  assert.match(turn.prompt, /别说成对方做的/)
  assert.match(turn.prompt, /有趣的点说了吗/)
  assert.match(turn.prompt, /有「人家」自己的看法吗/)
  assert.doesNotMatch(turn.prompt, /PERSONA_MARKER/)
  assert.doesNotMatch(turn.prompt, /PRIVATE_SECRET/)
})

test('buildTurn：重置首轮注入重置卡片 + 人设 + 两本日记地址 + 新消息（不塞日记正文）', () => {
  const env = tempEnv()
  appendEntry('public', { text: 'PUBLIC_MARKER', dir: env.diaryDir })
  appendEntry('private', { text: 'PRIVATE_SECRET', dir: env.diaryDir })
  const turn = buildTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER', diaryPackChars: 800 },
    messages: [{ text: '重置后的第一条' }],
    cli: 'C:/fake/cli.mjs',
  })
  assert.equal(turn.reset, true)
  assert.equal(turn.sessionId, 'bili-lite-dm')
  assert.match(turn.prompt, /会话重置 · 第 1 次/)
  assert.match(turn.prompt, /重置卡片/)
  assert.match(turn.prompt, /按天切换/)
  assert.match(turn.prompt, /PERSONA_MARKER/)
  assert.match(turn.prompt, /public\.md/)
  assert.match(turn.prompt, /private\.md/)
  assert.match(turn.prompt, /先 read 再开始/)
  assert.doesNotMatch(turn.prompt, /PUBLIC_MARKER/)
  assert.doesNotMatch(turn.prompt, /PRIVATE_SECRET/)
  assert.match(turn.prompt, /重置后的第一条/)
})

test('buildTurn：陌生人会话绝不注入人设/私密日记', () => {
  const env = tempEnv()
  appendEntry('private', { text: 'PRIVATE_SECRET', dir: env.diaryDir })
  const turn = buildTurn({
    key: 'u42',
    base: 'bili-lite-dm-u42',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER', diaryPackChars: 800 },
    sender: { uid: 42, uname: '路人' },
    messages: [{ text: '你好' }],
    cli: 'C:/fake/cli.mjs',
  })
  assert.equal(turn.sessionId, 'bili-lite-dm-u42')
  assert.match(turn.prompt, /陌生人私信/)
  assert.match(turn.prompt, /你好/)
  assert.doesNotMatch(turn.prompt, /PERSONA_MARKER/)
  assert.doesNotMatch(turn.prompt, /PRIVATE_SECRET/)
  assert.doesNotMatch(turn.prompt, /公开日记/)
})

test('buildTurn：阈值从 config 读（sessionResetRounds=2）', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(2))
  record(env, 'owner', 'bili-lite-dm', 1)
  const turn = buildTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { sessionResetRounds: 2, reviewPromptText: 'PERSONA_MARKER' },
    messages: [{ text: 'x' }],
    cli: 'C:/fake/cli.mjs',
  })
  assert.equal(turn.reset, true)
  assert.equal(turn.reason, 'rounds')
  assert.equal(turn.sessionId, 'bili-lite-dm-e2')
})

test('buildTurn：默认不按上下文切对话（20 轮 / 20 万字符也继续同一个会话）', () => {
  const env = tempEnv()
  writeSession(env.sessionsRoot, 'bili-lite-dm', turnEvents(20, { user: 4000, assistant: 3000, result: 3000 }))
  record(env, 'owner', 'bili-lite-dm', 1)
  const turn = buildTurn({
    key: 'owner',
    base: 'bili-lite-dm',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER' },
    messages: [{ text: '第二十轮' }],
    cli: 'C:/fake/cli.mjs',
  })
  assert.equal(turn.reset, false)
  assert.equal(turn.sessionId, 'bili-lite-dm')
  assert.ok(turn.contextChars > 50_000)
  // 非重置轮：只发新消息 + 一句风格，不重发人设
  assert.doesNotMatch(turn.prompt, /PERSONA_MARKER/)
  assert.match(turn.prompt, /第二十轮/)
})

test('buildMemoryPack：不依赖会话状态，任何地方都能手动读（diary pack）；日记只给地址', () => {
  const env = tempEnv()
  appendEntry('public', { text: 'PUBLIC_MARKER', dir: env.diaryDir })
  const pack = buildMemoryPack({
    cfg: { reviewPromptText: 'PERSONA_MARKER', diaryPackChars: 800 },
    diaryDir: env.diaryDir,
    cli: 'C:/fake/cli.mjs',
    home: 'C:/fake/home',
  })
  assert.match(pack, /PERSONA_MARKER/)
  assert.match(pack, /public\.md/)
  assert.match(pack, /先 read 再开始/)
  assert.doesNotMatch(pack, /PUBLIC_MARKER/)
  assert.match(pack, /按天切换/)
  assert.match(pack, /C:\/fake\/home/)
  assert.match(pack, /现在的你/)
  assert.match(pack, /最近记住的东西/)
  assert.match(pack, /说话/)
})

test('buildTurn：陌生人高峰直接跳过，不建会话、不发 prompt', () => {
  const env = tempEnv()
  const turn = buildTurn({
    key: 'u42',
    base: 'bili-lite-dm-u42',
    sessionsRoot: env.sessionsRoot,
    stateFile: env.stateFile,
    diaryDir: env.diaryDir,
    cfg: { reviewPromptText: 'PERSONA_MARKER' },
    sender: { uid: 42, uname: '路人' },
    messages: [{ text: '在吗' }],
    cli: 'C:/fake/cli.mjs',
    peak: true,
  })
  assert.equal(turn.skip, true)
  assert.equal(turn.reason, 'peak')
  assert.equal(turn.prompt, '')
  assert.equal(loadSessions({ stateFile: env.stateFile }).sessions.u42, undefined)
})

