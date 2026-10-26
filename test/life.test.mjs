// test/life.test.mjs — 她自己的生活：低谷期每小时一件小事，可手动写计划
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  actPrompt,
  addPlan,
  canAct,
  cycleOf,
  finishPlan,
  lifeHours,
  lifeTick,
  lifeSessionId,
  loadLife,
  noteAction,
} from '../src/life.mjs'
import { appendEntry, ensureDiary } from '../src/diary.mjs'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-life-'))
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return path.join(dir, 'life.json')
}

const workday = { kind: 'workday', name: '', date: '2026-10-23' }
const weekend = { kind: 'weekend', name: '', date: '2026-10-24' }
const at1800 = new Date('2026-10-23T10:00:00Z') // 北京时间 18:00
const at1830 = new Date('2026-10-23T10:30:00Z')
const at1000Workday = new Date('2026-10-23T02:00:00Z') // 北京时间 10:00（工作日高峰）
const at1200Workday = new Date('2026-10-23T04:00:00Z') // 北京时间 12:00（高峰结束）
const at1000Weekend = new Date('2026-10-24T02:00:00Z') // 周六 10:00

test('cycleOf：18:00 起算；凌晨 02:00 属于前一天', () => {
  assert.equal(cycleOf(at1800), '2026-10-23')
  assert.equal(cycleOf(new Date('2026-10-23T03:00:00Z')), '2026-10-22') // 11:00 → 前一天
  assert.equal(cycleOf(new Date('2026-10-23T18:00:00Z')), '2026-10-23') // 次日 02:00 → 23 日
})

test('lifeHours：低谷是每两小时一个整点；工作日 9 个，周末 12 个', () => {
  const work = lifeHours(workday).map((item) => item.key)
  assert.equal(work.length, 9)
  assert.deepEqual(work.slice(0, 5), ['00', '02', '04', '06', '08'])
  assert.equal(work.includes('01'), false)
  assert.equal(work.includes('09'), false)
  assert.equal(work.includes('10'), false)
  assert.equal(work.includes('11'), false)
  assert.equal(work.includes('12'), true)
  assert.equal(work.includes('13'), false)
  assert.equal(work.includes('14'), false)
  assert.equal(work.includes('18'), true)
  assert.equal(work.includes('20'), true)
  assert.deepEqual(lifeHours(weekend).map((item) => item.key), ['00', '02', '04', '06', '08', '10', '12', '14', '16', '18', '20', '22'])
})

test('lifeTick：18:00 叫她做这一次的事', () => {
  const file = tempFile()
  const tick = lifeTick({ now: at1800, dayInfo: workday, peak: false, file })
  assert.equal(tick.action, 'act')
  assert.equal(tick.slot, '18')
  assert.match(tick.prompt, /生活 · 这一次/)
  assert.match(tick.prompt, /【那一次是什么时候】2026-10-23 18:00/)
  assert.match(tick.prompt, /每两小时只醒一次/)
  assert.match(tick.prompt, /做一件小事/)
  assert.equal(tick.plan.auto, true)
  assert.equal(tick.plan.status, 'requested')
})

test('lifeTick：工作日高峰不叫醒，高峰结束的 12:00 叫醒', () => {
  const peakFile = tempFile()
  const peak = lifeTick({ now: at1000Workday, dayInfo: workday, peak: true, file: peakFile })
  assert.equal(peak.action, 'none')
  assert.equal(peak.reason, 'peak')

  const file = tempFile()
  const noon = lifeTick({ now: at1200Workday, dayInfo: workday, peak: false, file })
  assert.equal(noon.action, 'act')
  assert.equal(noon.slot, '12')
})

test('lifeTick：同一个时段只叫一次，隔两个小时再叫', () => {
  const file = tempFile()
  const first = lifeTick({ now: at1000Weekend, dayInfo: weekend, peak: false, file })
  assert.equal(first.action, 'act')
  assert.equal(first.slot, '10')

  const again = lifeTick({ now: new Date('2026-10-24T02:10:00Z'), dayInfo: weekend, peak: false, file })
  assert.equal(again.action, 'none')

  // 11:01 不是唤醒点（每两小时一次）
  const odd = lifeTick({ now: new Date('2026-10-24T03:01:00Z'), dayInfo: weekend, peak: false, file })
  assert.equal(odd.action, 'none')

  const next = lifeTick({ now: new Date('2026-10-24T04:01:00Z'), dayInfo: weekend, peak: false, file }) // 12:01
  assert.equal(next.action, 'act')
  assert.equal(next.slot, '12')
})

test('lifeTick：整点后超过 20 分钟就不再补这一小时', () => {
  const file = tempFile()
  const tick = lifeTick({ now: new Date('2026-10-24T02:25:00Z'), dayInfo: weekend, peak: false, file })
  assert.equal(tick.action, 'none')
})

test('lifeTick：三小时没做完的活动记为 missed，不影响下一轮', () => {
  const file = tempFile()
  const first = lifeTick({ now: at1000Weekend, dayInfo: weekend, peak: false, file })
  const later = lifeTick({ now: new Date('2026-10-24T06:05:00Z'), dayInfo: weekend, peak: false, file }) // 14:05
  assert.equal(later.action, 'act')
  assert.equal(later.slot, '14')
  const state = loadLife({ file })
  const stale = state.plans.find((plan) => plan.id === first.plan.id)
  assert.equal(stale.status, 'missed')
})

test('addPlan：写计划；不给 slot 就按 --at 的小时算；高峰拒绝；非法小时拒绝', () => {
  const file = tempFile()
  const plan = addPlan({
    intent: '想看看修表',
    activity: 'watch',
    at: '18:30',
    now: at1800,
    dayInfo: workday,
    file,
  })
  assert.equal(plan.cycle, '2026-10-23')
  assert.equal(plan.slot, '18')
  assert.equal(plan.at, '2026-10-23T18:30:00+08:00')
  assert.equal(plan.status, 'scheduled')
  assert.equal(plan.auto, false)
  assert.throws(
    () =>
      addPlan({
        intent: '高峰',
        activity: 'watch',
        at: '15:30',
        now: at1800,
        dayInfo: workday,
        file,
      }),
    /高峰/,
  )
  assert.throws(
    () => addPlan({ slot: '24', intent: 'x', at: '18:30', now: at1800, dayInfo: workday, file }),
    /未知的生活场次/,
  )
})

test('lifeTick：这一轮已排了手写计划，就不再另叫', () => {
  const file = tempFile()
  addPlan({ intent: '想看看修表', activity: 'watch', at: '18:30', now: at1800, dayInfo: workday, file })
  const tick = lifeTick({ now: new Date('2026-10-23T10:02:00Z'), dayInfo: workday, peak: false, file }) // 18:02
  assert.equal(tick.action, 'none')
})

test('lifeTick：手写计划到点执行；finish 收尾', () => {
  const file = tempFile()
  lifeTick({ now: at1800, dayInfo: workday, peak: false, file })
  const plan = addPlan({
    intent: '想看看修表',
    activity: 'watch',
    at: '18:30',
    now: at1800,
    dayInfo: workday,
    file,
  })
  const tick = lifeTick({ now: at1830, dayInfo: workday, peak: false, file })
  assert.equal(tick.action, 'execute')
  assert.equal(tick.plan.id, plan.id)
  assert.match(tick.prompt, /生活 · 执行/)
  const done = finishPlan(plan.id, { result: '看了两条', file })
  assert.equal(done.ok, true)
  assert.equal(done.plan.status, 'done')
})

test('技术上限：点赞/收藏/关注/取关不限，动态 3，评论停用 0，投币 5', () => {
  const file = tempFile()
  for (let i = 0; i < 20; i++) {
    assert.equal(canAct('like', { file }).ok, true)
    noteAction('like', { file })
    assert.equal(canAct('fav', { file }).ok, true)
    noteAction('fav', { file })
    assert.equal(canAct('follow', { file }).ok, true)
    noteAction('follow', { file })
    assert.equal(canAct('unfollow', { file }).ok, true)
    noteAction('unfollow', { file })
  }
  assert.equal(canAct('like', { file }).ok, true)
  assert.equal(canAct('like', { file }).cap, null)

  for (let i = 0; i < 3; i++) {
    assert.equal(canAct('dynamic', { file }).ok, true)
    noteAction('dynamic', { file })
  }
  assert.equal(canAct('dynamic', { file }).ok, false)

  // 评论：已停用（cap 0），永远 false
  assert.equal(canAct('comment', { file }).cap, 0)
  assert.equal(canAct('comment', { file }).ok, false)
  assert.equal(canAct('comment', { file }).used, 0)
  assert.doesNotMatch(canAct('comment', { file }).reason, /上限|额度/)

  for (let i = 0; i < 5; i++) {
    assert.equal(canAct('coin', { file, coins: 10 }).ok, true)
    noteAction('coin', { file })
  }
  assert.equal(canAct('coin', { file, coins: 10 }).ok, false)
  assert.equal(canAct('coin', { file, coins: 0 }).ok, false)
})

test('actPrompt：日记只给文件地址，让她自己 read（不塞正文），并鼓励想发动态就发', () => {
  const file = tempFile()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-diary-'))
  ensureDiary('public', { dir })
  ensureDiary('private', { dir })
  appendEntry('public', {
    text: '这段正文不应该出现在提示词里。',
    at: new Date('2026-10-24T10:00:00+08:00'),
    dir,
  })
  const prev = process.env.BILI_LITE_DIARY_DIR
  process.env.BILI_LITE_DIARY_DIR = dir
  try {
    const plan = addPlan({ slot: '14', intent: '看两条', at: '14:20', file })
    const prompt = actPrompt(plan, { file })
    assert.match(prompt, /【日记（写之前自己 read/)
    assert.match(prompt, /public\.md/)
    assert.match(prompt, /private\.md/)
    assert.doesNotMatch(prompt, /这段正文不应该出现在提示词里/)
    assert.match(prompt, /想发动态就发/)
  } finally {
    if (prev === undefined) delete process.env.BILI_LITE_DIARY_DIR
    else process.env.BILI_LITE_DIARY_DIR = prev
  }
})

test('actPrompt：默认每轮都允许分享，不再掷概率', () => {
  const file = tempFile()
  const plan = addPlan({ slot: '14', intent: '想随便看两条', at: '14:20', file })
  const prompt = actPrompt(plan, { file })
  assert.match(prompt, /【想分享就分享】/)
  assert.match(prompt, /life say --text/)
  assert.doesNotMatch(prompt, /【这次先不主动说】/)
  assert.doesNotMatch(prompt, /lifeShareChance/)
})

test('生活提示词：评论已停用，不再给 comment 命令', () => {
  const file = tempFile()
  const plan = addPlan({ slot: '14', intent: '想随便看两条', at: '14:20', file })
  const prompt = actPrompt(plan, { file })
  assert.match(prompt, /评论功能已停用/)
  assert.match(prompt, /评论 停用/)
  assert.doesNotMatch(prompt, /life action comment --bvid/)
  assert.doesNotMatch(prompt, /每天最多 5 条/)
  assert.match(prompt, /comments list/)
  // 生活回合不是回主人，也别往主人私信里发东西
  assert.match(prompt, /不是回他、也不算跟他汇报/)
  assert.match(prompt, /别用 `reply` 往主人私信发东西/)
  assert.match(prompt, /不是给主人发消息/)
  // 心情由她自己调
  assert.match(prompt, /心情可以由你自己调/)
  // 稳定段在前、变动段（心情/计数/时间）在后，方便命中前缀缓存
  assert.ok(prompt.indexOf('【这一次】') < prompt.indexOf('【今天的技术计数】'), '计数在稳定段之后')
  assert.ok(prompt.indexOf('mood adjust') < prompt.indexOf('【现在的心情】'), '心情变动段在最后')
  assert.ok(prompt.indexOf('【bili-lite 生活') < prompt.indexOf('【那一次是什么时候】'), '时间不放在最前面')
  // 生活回合每轮开新会话，人设原文进稳定前缀；印象/发言不进提示词（用 life recall 现查）
  assert.match(prompt, /【人设 · 唯一真源 prompts\/review\.md】/)
  assert.doesNotMatch(prompt, /【最近记住的东西】/)
  assert.doesNotMatch(prompt, /【最近说过的话/)
})

test('lifeSessionId：刷视频一天一个会话（同一整天同一个 id，跨天才换）', () => {
  // 2026-10-25T18:01Z = 北京时间 10-26 02:01；同一天不同整点必须是同一个会话
  const at0201 = new Date('2026-10-25T18:01:00Z')
  const at2201 = new Date('2026-10-26T14:01:00Z') // 北京时间 10-26 22:01
  assert.equal(lifeSessionId(at0201), 'bili-lite-life-2026-10-26')
  assert.equal(lifeSessionId(at2201), 'bili-lite-life-2026-10-26')
  // 跨天（北京时间 10-27 00:01）才换新会话
  assert.equal(lifeSessionId(new Date('2026-10-26T16:01:00Z')), 'bili-lite-life-2026-10-27')
})

test('actPrompt：同一个对话用一整天，日记路径每轮都给', () => {
  const file = tempFile()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-diary-'))
  ensureDiary('public', { dir })
  ensureDiary('private', { dir })
  const prev = process.env.BILI_LITE_DIARY_DIR
  process.env.BILI_LITE_DIARY_DIR = dir
  try {
    const plan = addPlan({ slot: '14', intent: '看两条', at: '14:20', file })
    const prompt = actPrompt(plan, { file })
    // 一天一个会话：提示词里点明「今天一直在这个对话里」
    assert.match(prompt, /【同一个对话】今天一直在这个对话里/)
    assert.match(prompt, /bili-lite-life-\d{4}-\d{2}-\d{2}/)
    // 日记路径（公开/私密）直接在提示词里
    assert.match(prompt, /【日记路径】/)
    assert.match(prompt, /【日记（写之前自己 read/)
    assert.ok(prompt.includes(path.join(dir, 'public.md')), '公开日记绝对路径')
    assert.ok(prompt.includes(path.join(dir, 'private.md')), '私密日记绝对路径')
    // 两次刷视频用同一个会话 id
    assert.equal(lifeSessionId(new Date()), lifeSessionId(new Date()))
  } finally {
    if (prev === undefined) delete process.env.BILI_LITE_DIARY_DIR
    else process.env.BILI_LITE_DIARY_DIR = prev
  }
})

test('finishPlan：收尾顺带漂一点心情（6 小时内只漂一次）', () => {
  const file = tempFile()
  const plan = addPlan({ slot: '14', intent: '想随便看两条', at: '14:20', file })
  const done = finishPlan(plan.id, { result: '看了两条', file })
  assert.equal(done.ok, true)
  assert.equal(done.plan.status, 'done')
  assert.ok(done.mood, '返回当前心情')
  // 再收尾一次不会重复漂移（driftMood 6 小时节流）
  const again = finishPlan(plan.id, { result: '再看一次', file })
  assert.equal(again.ok, true)
})
