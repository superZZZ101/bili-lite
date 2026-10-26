// test/decay.test.mjs — 互动衰减规则（纯函数）
import test from 'node:test'
import assert from 'node:assert/strict'
import { computeDecay, shouldShareToday, markInteraction, dayDiff } from '../src/decay.mjs'

const DAY = 86400000
const now = new Date('2026-10-22T12:00:00+08:00')

test('dayDiff：按北京自然日计算', () => {
  assert.equal(dayDiff(Date.parse('2026-10-20T23:00:00+08:00'), Date.parse('2026-10-21T00:30:00+08:00')), 1)
  assert.equal(dayDiff(Date.parse('2026-10-01T10:00:00+08:00'), Date.parse('2026-10-22T10:00:00+08:00')), 21)
})

test('computeDecay：没有互动记录 → normal', () => {
  const d = computeDecay({}, now)
  assert.equal(d.mode, 'normal')
  assert.equal(d.everyNDays, 1)
})

test('computeDecay：3 天内正常，4~7 天降频，超过 7 天暂停', () => {
  const at = (days) => ({ lastInteractionAt: new Date(now.getTime() - days * DAY).toISOString() })
  assert.equal(computeDecay(at(0), now).mode, 'normal')
  assert.equal(computeDecay(at(3), now).mode, 'normal')
  assert.equal(computeDecay(at(4), now).mode, 'low')
  assert.equal(computeDecay(at(4), now).everyNDays, 2)
  assert.equal(computeDecay(at(7), now).mode, 'low')
  assert.equal(computeDecay(at(8), now).mode, 'off')
  assert.equal(computeDecay(at(30), now).mode, 'off')
  assert.match(computeDecay(at(8), now).reason, /暂停推荐/)
})

test('shouldShareToday：normal 每天都发；low 每隔一天；off 不发', () => {
  const normal = { mode: 'normal', everyNDays: 1 }
  assert.equal(shouldShareToday(normal, '2026-10-22', '2026-10-22').share, true)

  const low = { mode: 'low', everyNDays: 2 }
  assert.equal(shouldShareToday(low, '2026-10-21', '2026-10-22').share, false)
  assert.equal(shouldShareToday(low, '2026-10-20', '2026-10-22').share, true)
  assert.equal(shouldShareToday(low, null, '2026-10-22').share, true)

  const off = { mode: 'off', everyNDays: 0 }
  assert.equal(shouldShareToday(off, '2026-10-20', '2026-10-22').share, false)
})

test('markInteraction：只接受更新的时间戳，并清掉一次性通知标记', () => {
  const state = { decayNotifiedAt: 'x' }
  markInteraction(state, Math.floor(now.getTime() / 1000), 'dm')
  assert.equal(new Date(state.lastInteractionAt).getTime(), now.getTime())
  assert.equal(state.interactionCount, 1)
  assert.equal(state.decayNotifiedAt, undefined)

  markInteraction(state, Math.floor((now.getTime() - 5 * DAY) / 1000), 'dm')
  assert.equal(new Date(state.lastInteractionAt).getTime(), now.getTime(), '旧消息不应回退互动时间')
  assert.equal(state.interactionCount, 1)
})

test('互动后立刻恢复 normal', () => {
  const state = { lastInteractionAt: new Date(now.getTime() - 10 * DAY).toISOString() }
  assert.equal(computeDecay(state, now).mode, 'off')
  markInteraction(state, now.getTime())
  assert.equal(computeDecay(state, now).mode, 'normal')
})
