// test/catchup.test.mjs — 补跑：错过时「非高峰立刻跑 / 高峰等到结束立刻跑」
import test from 'node:test'
import assert from 'node:assert/strict'
import { nonPeakMinute, isPeak, fmtMinutes } from '../src/calendar.mjs'

const workday = { kind: 'workday' }
const weekend = { kind: 'weekend' }
const holiday = { kind: 'holiday' }

test('补跑：现在非高峰 → 立刻（就是当前时刻向上取整到 5 分钟）', () => {
  assert.equal(nonPeakMinute(workday, 8 * 60 + 50), 8 * 60 + 50) // 08:50 非高峰
  assert.equal(nonPeakMinute(workday, 20 * 60 + 7), 20 * 60 + 10) // 20:07 → 20:10
  assert.equal(nonPeakMinute(weekend, 10 * 60 + 2), 10 * 60 + 5)
})

test('补跑：现在高峰 → 等到高峰结束（09:30→12:00，14:30→18:00）', () => {
  assert.equal(nonPeakMinute(workday, 9 * 60 + 30), 12 * 60)
  assert.equal(nonPeakMinute(workday, 13 * 60), 13 * 60) // 12:00–14:00 是空闲
  assert.equal(nonPeakMinute(workday, 14 * 60 + 30), 18 * 60)
  assert.equal(nonPeakMinute(workday, 10 * 60 + 59), 12 * 60)
})

test('补跑：22:00 之后仍是非高峰，立刻跑（不再限制 06:00–22:00）', () => {
  assert.equal(nonPeakMinute(workday, 22 * 60 + 30), 22 * 60 + 30)
  assert.equal(nonPeakMinute(holiday, 23 * 60), 23 * 60)
})

test('补跑：所有返回时刻都不是高峰', () => {
  for (const day of [workday, weekend, holiday]) {
    for (let m = 0; m < 24 * 60; m += 17) {
      const target = nonPeakMinute(day, m)
      assert.ok(target != null)
      assert.equal(isPeak(day, target), false, `${day.kind} ${fmtMinutes(m)} → ${fmtMinutes(target)} 还在高峰`)
    }
  }
})
