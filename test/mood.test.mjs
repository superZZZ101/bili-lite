// test/mood.test.mjs — 她自己的心情：五根轴 + 底色 + 自动微调 + 历史
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  adjustMood,
  buildMoodHistoryHtml,
  defaultMood,
  driftMood,
  isQuiet,
  loadMood,
  MOOD_LIMITS,
  moodHistory,
  moodText,
  parseBlend,
  readMoodLog,
  setMood,
  sparkline,
} from '../src/mood.mjs'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-mood-'))
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return path.join(dir, 'mood.json')
}

test('loadMood：没有文件时是默认的「潮」，blend 为空', () => {
  const mood = loadMood({ file: tempFile() })
  assert.equal(mood.label, '潮')
  assert.equal(mood.talk, 0.6)
  assert.deepEqual(mood.blend, [])
  assert.equal(isQuiet(mood), false)
})

test('setMood：藏 = 不想说话；可以单独调一根轴；底色会渲染', () => {
  const file = tempFile()
  const quiet = setMood({ label: '藏', note: '今天不太想说话', blend: '累,想被夸' }, { file })
  assert.equal(quiet.label, '藏')
  assert.equal(isQuiet(quiet), true)
  assert.deepEqual(quiet.blend, ['累', '想被夸'])
  assert.match(moodText(quiet), /今天不太想说话/)
  assert.match(moodText(quiet), /底色：累、想被夸/)
  const awake = setMood({ talk: 0.9 }, { file })
  assert.equal(awake.label, '藏')
  assert.equal(isQuiet(awake), false)
})

test('parseBlend：逗号/空格/数组，最多两个词', () => {
  assert.deepEqual(parseBlend('累, 想被夸'), ['累', '想被夸'])
  assert.deepEqual(parseBlend('累，想被夸，第三'), ['累', '想被夸'])
  assert.deepEqual(parseBlend(['a', 'b', 'c']), ['a', 'b'])
  assert.deepEqual(parseBlend(''), [])
})

test('adjustMood：单次每轴最多 ±0.15', () => {
  const file = tempFile()
  const result = adjustMood({ warmth: 0.5, why: '被戳到', source: 'life:video' }, { file })
  assert.equal(result.ok, true)
  assert.equal(result.delta.warmth, MOOD_LIMITS.maxSingle)
  assert.equal(result.mood.warmth, 0.75)
})

test('adjustMood：同一个来源 10 分钟内不能连续调', () => {
  const file = tempFile()
  const now = new Date('2026-10-23T05:00:00Z')
  assert.equal(adjustMood({ warmth: 0.1, source: 'life:video' }, { file, now }).ok, true)
  const again = adjustMood({ warmth: 0.1, source: 'life:video' }, { file, now: new Date(now.getTime() + 60_000) })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'cooldown')
})

test('adjustMood：一小时 0.25 的预算', () => {
  const file = tempFile()
  const now = new Date('2026-10-23T05:00:00Z')
  assert.equal(adjustMood({ warmth: 0.15, source: 'a' }, { file, now }).ok, true)
  const second = adjustMood({ warmth: 0.15, source: 'b' }, { file, now: new Date(now.getTime() + 60_000) })
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'hourly-budget')
})

test('adjustMood：没有变化会拒绝；blend 可以单独改', () => {
  const file = tempFile()
  assert.equal(adjustMood({ source: 'a' }, { file }).ok, false)
  const result = adjustMood({ blend: '湿,旧', source: 'a' }, { file })
  assert.equal(result.ok, true)
  assert.deepEqual(result.mood.blend, ['湿', '旧'])
})

test('driftMood：隔得久了会往 0.5 漂，但不会一下跳满', () => {
  const file = tempFile()
  const old = {
    ...defaultMood(),
    energy: 0.05,
    updatedAt: new Date(Date.now() - 12 * 3600_000).toISOString(),
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(old), 'utf8')
  const drifted = driftMood(loadMood({ file }), { now: new Date(), file })
  assert.ok(drifted.energy > 0.05)
  assert.ok(drifted.energy <= 0.5)
  assert.ok(readMoodLog({ file }).some((entry) => entry.source === 'drift'))
})

test('moodHistory：按天过滤，set/adjust 都进日志', () => {
  const file = tempFile()
  const now = new Date()
  setMood({ label: '钝' }, { file })
  adjustMood({ warmth: 0.1, source: 'life:video', why: '被戳到' }, { file, now })
  const log = readMoodLog({ file })
  assert.ok(log.length >= 2)
  assert.ok(log.some((entry) => entry.source === 'set'))
  assert.ok(log.some((entry) => entry.source === 'life:video'))
  const history = moodHistory({ days: 1, now, file })
  assert.ok(history.length >= 2)
})

test('sparkline / HTML 曲线', () => {
  assert.equal(sparkline([0, 0.5, 1]), '▁▅█')
  const entries = [
    { at: new Date().toISOString(), label: '潮', blend: [], energy: 0.8, warmth: 0.6, talk: 0.7, expression: 0.8, collect: 0.6, source: 'set' },
    { at: new Date().toISOString(), label: '钝', blend: ['累'], energy: 0.3, warmth: 0.7, talk: 0.3, expression: 0.3, collect: 0.3, source: 'life:video' },
  ]
  const html = buildMoodHistoryHtml(entries)
  assert.match(html, /<svg/)
  assert.match(html, /能量/)
  assert.match(html, /心情曲线/)
})

test('moodText：包含名字、五根轴和底色', () => {
  const text = moodText({ ...defaultMood(), label: '钝', blend: ['累', '想被夸'] })
  assert.match(text, /心情/)
  assert.match(text, /能量/)
  assert.match(text, /说话欲/)
  assert.match(text, /钝/)
  assert.match(text, /累、想被夸/)
})
