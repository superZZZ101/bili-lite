// test/review.test.mjs — 点评提示词 / 私信分条（纯函数）
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_REVIEW_PROMPT,
  loadReviewPrompt,
  summarizeVideo,
  buildReviewPrompt,
  buildReplyPrompt,
  splitText,
  formatDmMessages,
} from '../src/review.mjs'

const video = {
  bvid: 'BV1xrnz6gEVD',
  title: '折1万次，会坏吗？iPhone Duo深度评测',
  owner: '影视飓风',
  duration: 1492,
  desc: '这次我们为 iPhone Duo 准备了一系列测试，包括折叠 10000 次的设备。',
  tags: ['数码', '手机'],
  stat: { view: 3653641, like: 207992, danmaku: 1000, reply: 500 },
  comments: [{ user: 'a', text: '说得很实在', like: 3 }],
  danmakuHeat: { summary: '弹幕集中在 02:04–04:09' },
  enrich: { subtitles: { available: true, text: '既然是折叠屏，逃不过折这个问题……' } },
}

test('loadReviewPrompt：默认读随包 prompts/review.md，内联可覆盖', () => {
  const loaded = loadReviewPrompt({})
  // 随包带了 prompts/review.md（人设文件），没有配置时应该用它，而不是内置文案
  assert.match(loaded.source, /prompts[\\/]review\.md$/)
  assert.ok(loaded.text.length > 100)
  assert.equal(loadReviewPrompt({ reviewPromptText: '自定义' }).source, 'inline')
  assert.equal(loadReviewPrompt({ reviewPromptText: '自定义' }).text, '自定义')
})

test('summarizeVideo：压缩材料并带字幕提示', () => {
  const s = summarizeVideo(video)
  assert.equal(s.bvid, 'BV1xrnz6gEVD')
  assert.equal(s.up, '影视飓风')
  assert.ok(s.subtitleSnippet.includes('折叠屏'))
  assert.ok(s.danmakuHeat.includes('02:04'))
  assert.equal(summarizeVideo({}).subtitleNote, '无字幕，只能依据标题/简介/热评/弹幕')
})

test('buildReviewPrompt：包含要求、材料、字数限制', () => {
  const prompt = buildReviewPrompt(video, { maxChars: 150 })
  assert.ok(prompt.includes('总长不超过 150 字'))
  assert.ok(prompt.includes('BV1xrnz6gEVD'))
  assert.ok(prompt.includes('影视飓风'))
  assert.ok(prompt.includes('只输出点评正文'))
  assert.ok(prompt.includes(DEFAULT_REVIEW_PROMPT.slice(0, 10)))
})

test('buildReviewPrompt：自定义提示词会覆盖默认指令', () => {
  const prompt = buildReviewPrompt(video, { reviewPrompt: '你是一个毒舌影评人' })
  assert.ok(prompt.includes('你是一个毒舌影评人'))
})

test('buildReviewPrompt：extra 片段插在【输出】之前（日记提醒用）', () => {
  const prompt = buildReviewPrompt(video, { extra: '【日记】记一笔' })
  assert.match(prompt, /【日记】记一笔/)
  assert.ok(prompt.indexOf('【日记】记一笔') < prompt.indexOf('【输出】'))
})

test('buildReplyPrompt：区分纯聊天与分享视频', () => {
  const chat = buildReplyPrompt({ text: '这周有什么好看的' })
  assert.ok(chat.includes('这周有什么好看的'))
  assert.ok(!chat.includes('分享的视频材料'))
  const shared = buildReplyPrompt({ text: '你看看这个', video })
  assert.ok(shared.includes('分享的视频材料'))
  assert.ok(shared.includes('BV1xrnz6gEVD'))
})

test('splitText：超长按换行/硬切，结果每段不超限', () => {
  const text = Array.from({ length: 20 }, (_, i) => `第 ${i} 行内容`).join('\n')
  const parts = splitText(text, 50)
  assert.ok(parts.length > 1)
  for (const p of parts) assert.ok(p.length <= 50)
  assert.equal(parts.join('\n').replace(/\s+/g, ''), text.replace(/\s+/g, ''))
})

test('formatDmMessages：标题+一句话+点评+链接，含点评', () => {
  const picks = [
    {
      bvid: 'BV1xrnz6gEVD',
      title: '折1万次，会坏吗？iPhone Duo深度评测',
      oneLiner: '折痕和结构实测比参数表有信息量',
      review: '真的把机器折了一万次，看完对折叠屏寿命有概念；缺点是没测低温场景。',
      url: 'https://www.bilibili.com/video/BV1xrnz6gEVD',
    },
  ]
  const msgs = formatDmMessages(picks, 18)
  assert.equal(msgs.length, 1)
  assert.ok(msgs[0].includes('今天刷了 18 条'))
  assert.ok(msgs[0].includes(picks[0].title))
  assert.ok(msgs[0].includes(picks[0].review))
  assert.ok(!msgs[0].includes('一句话：'))
  assert.ok(!msgs[0].includes('点评：'))
  assert.ok(msgs[0].includes('BV1xrnz6gEVD'))
})

test('formatDmMessages：dmReview=false 时不带点评正文', () => {
  const picks = [{ bvid: 'BV1', title: 't', oneLiner: '一句话兜底', review: '这段点评不该出现', url: 'u' }]
  const msgs = formatDmMessages(picks, 1, { dmReview: false })
  assert.ok(!msgs[0].includes('这段点评不该出现'))
  assert.ok(msgs[0].includes('一句话兜底'))
})

test('formatDmMessages：超长自动拆成多条且每条不超限', () => {
  const picks = Array.from({ length: 3 }, (_, i) => ({
    bvid: `BV${i}`,
    title: `第 ${i} 条视频标题比较长一点测试分条`,
    oneLiner: '这是一句话推荐',
    review: '这是一段比较长的点评内容，'.repeat(6),
    url: `https://www.bilibili.com/video/BV${i}`,
  }))
  const msgs = formatDmMessages(picks, 3, { limit: 200 })
  assert.ok(msgs.length >= 2)
  for (const m of msgs) assert.ok(m.length <= 200)
})
