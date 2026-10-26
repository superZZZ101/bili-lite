// test/calendar.test.mjs — 北京时间 / 高峰时段 / 随机排程（纯函数，不访问网络）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  beijingParts,
  fmtMinutes,
  parseHHMM,
  allowedIntervals,
  isPeak,
  nextAllowedMinute,
  pickRandomSlot,
} from '../src/calendar.mjs'

const workday = { kind: 'workday', name: '周四', source: 'api' }
const holiday = { kind: 'holiday', name: '国庆节', source: 'api' }
const weekend = { kind: 'weekend', name: '', source: 'api' }

test('beijingParts：UTC 00:00 换算成北京时间 08:00', () => {
  const parts = beijingParts(new Date('2026-10-22T00:00:00Z'))
  assert.equal(parts.dateStr, '2026-10-22')
  assert.equal(parts.minutes, 8 * 60)
  assert.equal(parts.hour, 8)
})

test('beijingParts：跨日边界（UTC 16:30 = 北京 00:30 次日）', () => {
  const parts = beijingParts(new Date('2026-10-21T16:30:00Z'))
  assert.equal(parts.dateStr, '2026-10-22')
  assert.equal(parts.minutes, 30)
})

test('fmtMinutes / parseHHMM 往返', () => {
  assert.equal(fmtMinutes(0), '00:00')
  assert.equal(fmtMinutes(9 * 60 + 5), '09:05')
  assert.equal(fmtMinutes(24 * 60), '24:00')
  assert.equal(parseHHMM('14:30'), 870)
  assert.equal(parseHHMM('bad'), null)
  assert.equal(parseHHMM('25:00'), null)
})

test('allowedIntervals：工作日三段但覆盖全天（不再裁剪 06:00–22:00），周末/节假日全天', () => {
  assert.deepEqual(allowedIntervals(workday), [
    [0, 540],
    [720, 840],
    [1080, 1440],
  ])
  assert.deepEqual(allowedIntervals(weekend), [[0, 1440]])
  assert.deepEqual(allowedIntervals(holiday), [[0, 1440]])
})

test('allowedIntervals：时段覆盖 00:00–24:00 且不落高峰', () => {
  for (const day of [workday, weekend, holiday]) {
    for (const [from, to] of allowedIntervals(day)) {
      assert.ok(from >= 0 && to <= 1440, `${day.kind} ${from}-${to} 超出全天范围`)
      for (let m = from; m < to; m += 5) assert.equal(isPeak(day, m), false)
    }
  }
})

test('isPeak：工作日 09:00–12:00 与 14:00–18:00 为高峰，边界不含右端点', () => {
  assert.equal(isPeak(workday, 9 * 60), true)
  assert.equal(isPeak(workday, 11 * 60 + 59), true)
  assert.equal(isPeak(workday, 12 * 60), false)
  assert.equal(isPeak(workday, 13 * 60), false)
  assert.equal(isPeak(workday, 14 * 60), true)
  assert.equal(isPeak(workday, 17 * 60 + 59), true)
  assert.equal(isPeak(workday, 18 * 60), false)
  assert.equal(isPeak(workday, 8 * 60 + 59), false)
  // 周末 / 节假日全天不算高峰
  assert.equal(isPeak(weekend, 10 * 60), false)
  assert.equal(isPeak(holiday, 10 * 60), false)
})

test('nextAllowedMinute：高峰内给出下一个空闲时刻', () => {
  assert.equal(nextAllowedMinute(workday, 9 * 60 + 30), 12 * 60) // 上午高峰 → 12:00
  assert.equal(nextAllowedMinute(workday, 14 * 60 + 30), 18 * 60) // 下午高峰 → 18:00
  assert.equal(nextAllowedMinute(workday, 13 * 60 + 30), 13 * 60 + 30) // 午休本身可用
  assert.equal(nextAllowedMinute(workday, 7 * 60), 7 * 60)
})

test('pickRandomSlot：工作日 08:50 只会落在非高峰时段（08:53~09:00 或 12/18 点后）', () => {
  for (let i = 0; i < 30; i++) {
    const slot = pickRandomSlot(workday, '2026-10-22', 8 * 60 + 50, { minLead: 3 })
    assert.ok(slot, '应该有可用时段')
    assert.equal(isPeak(workday, slot.minutes), false, `slot ${slot.minutes} 落在高峰里了`)
    assert.ok(slot.minutes >= 0 && slot.minutes < 1440, '应落在全天范围内')
    assert.equal(slot.minutes % 5, 0)
    assert.match(slot.at, /^2026-10-22T\d{2}:\d{2}:00\+08:00$/)
  }
})

test('pickRandomSlot：节假日覆盖全天，且不会回到过去', () => {
  const slot = pickRandomSlot(holiday, '2026-10-01', 10 * 60, { minLead: 3 })
  assert.ok(slot.minutes >= 10 * 60 + 3)
  assert.ok(slot.minutes < 1440)
})

test('pickRandomSlot：22:00 之后当天仍可排（限制已解除，深夜也允许）', () => {
  for (const day of [workday, weekend, holiday]) {
    const slot = pickRandomSlot(day, '2026-10-22', 22 * 60, { minLead: 3 })
    assert.ok(slot, `${day.kind} 22:00 之后应仍可排程`)
    assert.ok(slot.minutes >= 22 * 60 + 3 && slot.minutes < 1440)
    assert.equal(isPeak(day, slot.minutes), false)
  }
})
