// test/archive.test.mjs — 会话日期解析与「保留最近 N 天」归档判定
import test from 'node:test'
import assert from 'node:assert/strict'

import { dayGap, dmSessionId, sessionDateOf, sessionsToArchive } from '../plugin/bili-lite-watch/index.js'

test('dmSessionId：按北京时间一天一个（跨午夜也换天）', () => {
  assert.equal(dmSessionId(new Date('2026-10-25T00:00:00+08:00')), 'bili-lite-dm-20261025')
  assert.equal(dmSessionId(new Date('2026-10-25T23:59:00+08:00')), 'bili-lite-dm-20261025')
  // UTC 16:00 = 北京时间次日 00:00
  assert.equal(dmSessionId(new Date('2026-10-25T16:00:00Z')), 'bili-lite-dm-20261026')
})

test('sessionDateOf：认 YYYYMMDD / YYYY-MM-DD / -eN，不认陌生人和无日期会话', () => {
  assert.equal(sessionDateOf('bili-lite-dm-20261025'), '20261025')
  assert.equal(sessionDateOf('bili-lite-dm-20261025-e2'), '20261025')
  assert.equal(sessionDateOf('bili-lite-life-2026-10-24'), '20261024')
  assert.equal(sessionDateOf('bili-lite-life-turn-20261025-08'), '20261025')
  assert.equal(sessionDateOf('bili-lite-dm-u3546711230253983'), null)
  assert.equal(sessionDateOf('bili-lite-permtest'), null)
  assert.equal(sessionDateOf('other-20261025'), null)
})

test('sessionsToArchive：只归档 4 天前及更早的日期会话', () => {
  const ids = [
    'bili-lite-dm-20261025',
    'bili-lite-dm-20261024',
    'bili-lite-dm-20261022',
    'bili-lite-dm-20261021',
    'bili-lite-dm-20261020',
    'bili-lite-dm-u123',
    'bili-lite-life-turn-20261021-18',
  ]
  assert.deepEqual(sessionsToArchive(ids, '20261025', 4), [
    'bili-lite-dm-20261020',
    'bili-lite-dm-20261021',
    'bili-lite-life-turn-20261021-18',
  ])
  assert.equal(dayGap('20261025', '20261021'), 4)
  assert.equal(dayGap('20261025', '20261025'), 0)
})
