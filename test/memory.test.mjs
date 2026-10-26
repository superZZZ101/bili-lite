// test/memory.test.mjs — 每月整理：留 63%，其余忘掉；pinned/最近 7 天保护
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendEntry, readEntries } from '../src/diary.mjs'
import { addImpression, loadImpressions } from '../src/impressions.mjs'
import { logSpeech, readSpeech } from '../src/speech.mjs'
import {
  collectEntries,
  consolidationPlan,
  consolidate,
  loadPins,
  memoryDue,
  pendingMonth,
  previousMonth,
} from '../src/memory.mjs'

function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-memory-'))
  test.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return {
    root,
    diaryDir: path.join(root, 'diary'),
    impressionsFile: path.join(root, 'impressions.json'),
    speechFile: path.join(root, 'speech.jsonl'),
    pinFile: path.join(root, 'pins.json'),
    metaFile: path.join(root, 'meta.json'),
    summaryFile: path.join(root, 'summary.md'),
    archiveDir: path.join(root, 'archive'),
  }
}

function at(month, day, hour = 12) {
  return new Date(`${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00+08:00`)
}

function fill(env, now) {
  for (let i = 0; i < 20; i++) {
    appendEntry('public', { text: `九月公开 ${i} ${'内容'.repeat(6)}`, title: `pub${i}`, at: at('2026-09', (i % 28) + 1), dir: env.diaryDir })
    appendEntry('private', { text: `九月私密 ${i} ${'感觉'.repeat(6)}`, title: `pri${i}`, at: at('2026-09', (i % 28) + 1), dir: env.diaryDir })
    addImpression(
      { title: `印象${i}`, author: `up${i}`, content: '内容', comment: '评论', why: '感觉', at: at('2026-09', (i % 28) + 1).toISOString() },
      { file: env.impressionsFile },
    )
    logSpeech(
      { channel: 'dm-owner', to: 1, text: `九月说过的话 ${i}`, at: at('2026-09', (i % 28) + 1).toISOString() },
      { file: env.speechFile },
    )
  }
  // 十月的内容：不属于九月，整理时必须原样保留
  appendEntry('public', { text: '十月公开，不能被误删', title: 'oct-public', at: at('2026-10', 2), dir: env.diaryDir })
  appendEntry('private', { text: '十月私密，不能被误删', title: 'oct-private', at: at('2026-10', 2), dir: env.diaryDir })
  addImpression({ title: '十月印象', why: '十月', at: at('2026-10', 2).toISOString() }, { file: env.impressionsFile })
  logSpeech({ channel: 'dm-owner', text: '十月的发言', at: at('2026-10', 2).toISOString() }, { file: env.speechFile })
  return now
}

test('previousMonth：按北京时间算上个月', () => {
  assert.equal(previousMonth(new Date('2026-10-01T02:30:00+08:00')), '2026-09')
  assert.equal(previousMonth(new Date('2026-01-15T12:00:00+08:00')), '2025-12')
})

test('collectEntries：只收目标月份，其他月份保留', () => {
  const env = tempEnv()
  fill(env)
  const entries = collectEntries({ month: '2026-09', now: at('2026-10', 5, 12), ...env })
  assert.equal(entries.filter((entry) => entry.category === 'diary-public').length, 20)
  assert.equal(entries.filter((entry) => entry.category === 'diary-private').length, 20)
  assert.equal(entries.filter((entry) => entry.category === 'impressions').length, 20)
  assert.equal(entries.filter((entry) => entry.category === 'speech').length, 20)
})

test('consolidationPlan：每类 63% 的目标', () => {
  const env = tempEnv()
  fill(env)
  const plan = consolidationPlan({ month: '2026-09', now: at('2026-10', 5, 12), ...env })
  assert.equal(plan.categories['diary-public'].eligible, 20)
  assert.equal(plan.categories['diary-public'].target, 13)
  assert.equal(plan.categories.impressions.target, 13)
  assert.equal(plan.categories.speech.target, 13)
})

test('consolidate：留 63%，其他月份不动，归档与总结都在', () => {
  const env = tempEnv()
  fill(env)
  const result = consolidate({
    month: '2026-09',
    keep: [],
    summary: '九月看了很多修表的东西。',
    now: at('2026-10', 5, 12),
    ...env,
  })
  assert.equal(result.ok, true)
  assert.equal(result.kept['diary-public'], 13)
  assert.equal(result.forgotten['diary-public'], 7)
  assert.equal(result.kept.impressions, 13)
  assert.equal(result.kept.speech, 13)

  const publicEntries = readEntries('public', { dir: env.diaryDir })
  const privateEntries = readEntries('private', { dir: env.diaryDir })
  assert.equal(publicEntries.length, 14) // 13 九月 + 1 十月
  assert.equal(privateEntries.length, 14)
  assert.ok(publicEntries.some((entry) => entry.title === 'oct-public'))
  assert.ok(privateEntries.some((entry) => entry.title === 'oct-private'))

  const impressions = loadImpressions({ file: env.impressionsFile })
  assert.equal(impressions.length, 14)
  assert.ok(impressions.some((item) => item.title === '十月印象'))
  const speech = readSpeech({ file: env.speechFile })
  assert.equal(speech.length, 14)
  assert.ok(speech.some((item) => item.text === '十月的发言'))

  assert.ok(fs.existsSync(path.join(env.archiveDir, '2026-09', 'summary.md')))
  assert.ok(fs.existsSync(path.join(env.archiveDir, '2026-09', 'meta.json')))
  assert.match(fs.readFileSync(env.summaryFile, 'utf8'), /修表/)
  assert.match(fs.readFileSync(env.metaFile, 'utf8'), /2026-09/)
})

test('consolidate：pinned 不参与遗忘', () => {
  const env = tempEnv()
  for (let i = 0; i < 15; i++) {
    appendEntry('public', { text: `pin 测试 ${i}`, title: `pin${i}`, at: at('2026-09', i + 1), dir: env.diaryDir })
  }
  const entries = collectEntries({ month: '2026-09', now: at('2026-10', 5, 12), ...env })
  const target = entries.find((entry) => entry.title === 'pin2')
  fs.mkdirSync(path.dirname(env.pinFile), { recursive: true })
  fs.writeFileSync(env.pinFile, JSON.stringify({ ids: [target.id] }), 'utf8')
  assert.deepEqual(loadPins({ file: env.pinFile }), [target.id])

  consolidate({ month: '2026-09', keep: [], now: at('2026-10', 5, 12), ...env })
  const kept = readEntries('public', { dir: env.diaryDir })
  assert.ok(kept.some((entry) => entry.title === 'pin2'))
})

test('consolidate：最近 7 天不参与遗忘', () => {
  const env = tempEnv()
  appendEntry('public', { text: '很久以前', title: 'old', at: at('2026-09', 1), dir: env.diaryDir })
  appendEntry('public', { text: '最近七天', title: 'recent', at: at('2026-09', 29), dir: env.diaryDir })
  consolidate({ month: '2026-09', keep: [], now: at('2026-09', 30, 12), ...env })
  const kept = readEntries('public', { dir: env.diaryDir })
  assert.ok(kept.some((entry) => entry.title === 'recent'))
})

// ── 2026-10-26：第一次遗忘的时机（以前要等到「有 35 天以上的旧记忆」，结果 11-01 整月跳过）──

test('memoryDue：第一次整理只要上个月有记忆，1 号 02:00 就到点', () => {
  const env = tempEnv()
  appendEntry('public', { text: '十月里的一句话', title: 'oct', at: at('2026-10', 20), dir: env.diaryDir })
  const opts = { diaryDir: env.diaryDir, impressionsFile: env.impressionsFile, speechFile: env.speechFile, metaFile: env.metaFile }

  // 10-26（当天）：上个月是 9 月，没有记忆 → 不该整理
  const today = memoryDue({ now: at('2026-10', 26, 11), ...opts })
  assert.equal(today.due, false)
  assert.equal(today.reason, 'no-old-memory')

  // 11-01 01:00：还没到 02:00
  assert.equal(memoryDue({ now: at('2026-11', 1, 1), ...opts }).due, false)

  // 11-01 02:05：到点，且整理的是 10 月（以前的 bug 就是这里整月跳过）
  const due = memoryDue({ now: at('2026-11', 1, 2), ...opts })
  assert.equal(due.due, true)
  assert.equal(due.reason, 'first-monthly')
  assert.equal(due.suggestedMonth, '2026-10')

  // 错过 1 号也能补跑（11-15 仍然 due，月份还是 10 月）
  const late = memoryDue({ now: at('2026-11', 15, 3), ...opts })
  assert.equal(late.due, true)
  assert.equal(late.suggestedMonth, '2026-10')
})

test('memoryDue：上个月没东西可整理就不催（不会空跑）', () => {
  const env = tempEnv()
  appendEntry('public', { text: '只有十月的', title: 'oct', at: at('2026-10', 20), dir: env.diaryDir })
  const r = memoryDue({
    now: at('2026-11', 1, 2),
    diaryDir: env.diaryDir,
    impressionsFile: env.impressionsFile,
    speechFile: env.speechFile,
    metaFile: env.metaFile,
  })
  // 11 月的「上个月」是 10 月，有内容 → due；把时间推到 12-01，上个月是 11 月（空的）→ 不催
  assert.equal(r.due, true)
  const dec = memoryDue({
    now: at('2026-12', 1, 2),
    diaryDir: env.diaryDir,
    impressionsFile: env.impressionsFile,
    speechFile: env.speechFile,
    metaFile: env.metaFile,
  })
  assert.equal(dec.due, false)
  assert.equal(dec.reason, 'no-old-memory')
})

test('pendingMonth：算出上个月待整理的条数', () => {
  const env = tempEnv()
  appendEntry('public', { text: '十月一条', title: 'a', at: at('2026-10', 3), dir: env.diaryDir })
  logSpeech({ channel: 'comment', text: '十月说过一句', at: at('2026-10', 4).toISOString() }, { file: env.speechFile })
  const pending = pendingMonth({ now: at('2026-11', 1, 2), diaryDir: env.diaryDir, impressionsFile: env.impressionsFile, speechFile: env.speechFile })
  assert.equal(pending.month, '2026-10')
  assert.ok(pending.entries >= 2)
})
