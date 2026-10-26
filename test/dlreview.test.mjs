// test/dlreview.test.mjs — 点评上限 480 + 长点评自动分条
import test from 'node:test'
import assert from 'node:assert/strict'
import { formatDmMessages, buildReviewPrompt, REVIEW_MAX_CHARS, splitText } from '../src/review.mjs'

const video = { bvid: 'BV1xrnz6gEVD', title: '折1万次，会坏吗？iPhone Duo深度评测', owner: '影视飓风', duration: 1492 }

test('REVIEW_MAX_CHARS 是 480，提示词默认按 480 字要求', () => {
  assert.equal(REVIEW_MAX_CHARS, 480)
  const prompt = buildReviewPrompt(video)
  assert.ok(prompt.includes('总长不超过 480 字'))
})

test('formatDmMessages：480 字点评不会被截成 200 字', () => {
  const review = '这'.repeat(480)
  const msgs = formatDmMessages([{ bvid: 'BV1', title: 't', oneLiner: 'o', review, url: 'u' }], 1)
  const all = msgs.join('\n')
  // 允许中间插入「点评（续）：」分段，但 480 个字必须都在
  assert.ok((all.match(/这/g) || []).length >= 480, `丢了内容：只剩 ${(all.match(/这/g) || []).length} 字`)
  assert.ok(!all.includes('…'), '不应出现省略号截断')
})

test('formatDmMessages：480 字点评 + 标题会拆成多条，每条 ≤460', () => {
  const review = '这是一段很具体的点评内容，'.repeat(40).slice(0, 480)
  const picks = [
    { bvid: 'BV1', title: '第一条视频标题', oneLiner: '一句话推荐', review, url: 'https://www.bilibili.com/video/BV1' },
    { bvid: 'BV2', title: '第二条视频标题', oneLiner: '一句话推荐', review, url: 'https://www.bilibili.com/video/BV2' },
  ]
  const msgs = formatDmMessages(picks, 18)
  assert.ok(msgs.length >= 3, `应该拆成多条，实际 ${msgs.length}`)
  for (const m of msgs) assert.ok(m.length <= 460, `单条 ${m.length} 超限`)
  const joined = msgs.join('\n')
  assert.ok(joined.includes('BV1'))
  assert.ok(joined.includes('BV2'))
})

test('splitText：硬切后拼回去内容不丢（去空白）', () => {
  const text = '长文本'.repeat(300)
  const parts = splitText(text, 460)
  const norm = (s) => s.replace(/\s+/g, '')
  assert.equal(norm(parts.join('')), norm(text))
  for (const p of parts) assert.ok(p.length <= 460)
})
