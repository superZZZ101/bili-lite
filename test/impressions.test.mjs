// test/impressions.test.mjs — 印象：作者/题目/内容/评论/感觉，链接可选
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  addImpression,
  impressionStats,
  loadImpressions,
  pinImpression,
  recallImpressions,
  renderRecall,
} from '../src/impressions.mjs'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-imp-'))
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return path.join(dir, 'impressions.json')
}

test('addImpression：记下作者/题目/内容/评论/感觉，链接可以没有', () => {
  const file = tempFile()
  const result = addImpression(
    {
      title: '上海表',
      author: '老陈',
      content: '拆开全是灰',
      comment: '爷爷也有一块',
      why: '想起主人桌上那块',
      mood: '湿',
    },
    { file },
  )
  assert.equal(result.ok, true)
  assert.equal(result.item.bvid, '')
  assert.equal(loadImpressions({ file }).length, 1)
  assert.match(renderRecall(loadImpressions({ file })), /链接：没记住/)
})

test('addImpression：同一条、同样的感觉不重复记', () => {
  const file = tempFile()
  addImpression({ title: '上海表', content: '灰', why: '想起主人' }, { file })
  const again = addImpression({ title: '上海表', content: '灰', why: '想起主人' }, { file })
  assert.equal(again.duplicate, true)
  assert.equal(loadImpressions({ file }).length, 1)
})

test('recallImpressions：按话题挑，pinned 优先', () => {
  const file = tempFile()
  addImpression({ title: '深海热泉', content: '螃蟹养细菌', why: '海底像另一个首页', mood: '潮' }, { file })
  const pinned = addImpression({ title: '修表', content: '上海表', why: '想起主人', mood: '湿' }, { file })
  addImpression({ title: '猫', content: '睡觉', why: '没感觉' }, { file })
  pinImpression(pinned.item.id, true, { file })
  const recalled = recallImpressions({ limit: 2, topic: '表', file })
  assert.ok(recalled.length >= 1)
  assert.ok(recalled.some((item) => item.title === '修表'))
})

test('renderRecall：有 bvid 时给链接，fuzzy 时提醒别硬说', () => {
  const file = tempFile()
  addImpression({ title: '深海', bvid: 'BV1xxxx', why: '好看' }, { file })
  const text = renderRecall(loadImpressions({ file }))
  assert.match(text, /BV1xxxx/)
  assert.doesNotMatch(text, /链接：没记住/)
})

test('impressionStats：只给概览', () => {
  const file = tempFile()
  addImpression({ title: 'a', why: 'b' }, { file })
  const stats = impressionStats({ file })
  assert.equal(stats.count, 1)
  assert.equal(stats.pinned, 0)
})
