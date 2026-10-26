// test/speech.test.mjs — 说过的话 + 语言习惯：防复读、防照读日记、防刷梗
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendEntry } from '../src/diary.mjs'
import {
  briefText,
  checkSpeech,
  logSpeech,
  recentSpeech,
  renderSpeechBrief,
  speechProfile,
  speechStats,
} from '../src/speech.mjs'

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-speech-'))
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return dir
}

test('logSpeech / recentSpeech：记下频道、对象、主动标记', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  logSpeech({ channel: 'dm-owner', to: 1, text: '今天首页很吵。', mood: '湿' }, { file })
  logSpeech({ channel: 'proactive', to: 1, text: '还没睡呀。', proactive: true }, { file })
  const items = recentSpeech({ limit: 5, file })
  assert.equal(items.length, 2)
  assert.equal(items[1].proactive, true)
  assert.equal(speechStats({ file }).count, 2)
})

test('logSpeech：评论记成 comment，不再被吞进 dm-owner', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  logSpeech({ channel: 'comment', text: '这条视频讲得实在', replyTo: 'BV1xx411c7mD' }, { file })
  logSpeech({ channel: 'dynamic', text: '今天想发一条', proactive: true }, { file })
  logSpeech({ channel: 'dm-owner', to: 1, text: '回主人一句' }, { file })
  const items = recentSpeech({ limit: 5, file })
  assert.equal(items[0].channel, 'comment')
  assert.equal(items[0].replyTo, 'BV1xx411c7mD')
  assert.equal(speechStats({ file }).byChannel.comment, 1)
  assert.equal(speechStats({ file }).byChannel['dm-owner'], 1)
})

test('renderSpeechBrief：评论和私信都进「不要复读」清单，标签分得开', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  logSpeech({ channel: 'comment', text: '评论区说过的一句', replyTo: 'BV1xx411c7mD' }, { file })
  logSpeech({ channel: 'dm-owner', to: 1, text: '私信里说过的一句' }, { file })
  const brief = renderSpeechBrief({ channels: ['dm-owner', 'proactive', 'comment'], limit: 4, file })
  assert.match(brief, /（评论）：「评论区说过的一句」/)
  assert.match(brief, /（说过）：「私信里说过的一句」/)
})

test('renderSpeechBrief：带最近说过的话 + 用滥的词', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  for (let i = 0; i < 3; i++) logSpeech({ channel: 'dm-owner', to: 1, text: `人家用尾巴想了想 ${i}` }, { file })
  const brief = renderSpeechBrief({ channel: 'dm-owner', limit: 3, file })
  assert.match(brief, /最近说过的话/)
  assert.match(brief, /尾巴/)
  assert.match(brief, /最近用滥/)
})

test('briefText：短句整句保留，长句在标点处收尾，不留半截', () => {
  const short = '主人今天问的这个，人家想了想还是觉得，它不算坏，只是没人给它画过线。'
  assert.equal(briefText(short), short)

  const long = `${'甲'.repeat(100)}。${'乙'.repeat(200)}`
  const cut = briefText(long)
  assert.ok(cut.length <= 241, '长度不超过上限')
  assert.ok(cut.endsWith('…'), '截断要有省略号')
  assert.ok(cut.includes('。…'), '在句号处收尾，不是硬切')
  assert.ok(!cut.includes('乙'), '长句只保留第一句')

  // 80 字左右的历史发言不再被砍
  const mid = '呜…主人怎么问这个嘛，送命题欸（耳朵耷拉）。人家看完心里毛毛的。它倒不算坏，是被评论区一句一句问着。'
  assert.equal(briefText(mid), mid)
})

test('renderSpeechBrief：最近说过的话给整句，不再截成半截', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  const said =
    '主人！！这张是故意发给人家看的吧（尾巴啪嗒）人家本来还以为能翻到可爱的小鱼，结果一屏全是切好的刺身…人家是鲸鱼欸，不是等着被摆盘的那种呀。'
  logSpeech({ channel: 'dm-owner', to: 1, text: said }, { file })
  const brief = renderSpeechBrief({ channel: 'dm-owner', limit: 1, file })
  assert.ok(brief.includes(said), '整句都在提示词里')
})

test('speechProfile：统计高频意象和开场', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  logSpeech({ channel: 'dm-owner', text: '主人，尾巴啪嗒。' }, { file })
  logSpeech({ channel: 'dm-owner', text: '主人，尾巴又啪嗒。' }, { file })
  const profile = speechProfile({ file })
  assert.ok(profile.motifs.some(([motif]) => motif === '尾巴'))
  assert.ok(profile.openings.length > 0)
})

test('checkSpeech：和之前说过的话重合太多会警告', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  const old = '今天看到一个老头拆开一块上海表，里面全是灰。'
  logSpeech({ channel: 'dm-owner', to: 1, text: old }, { file })
  const result = checkSpeech(old, { channel: 'dm-owner', to: 1, file, diaryDir: path.join(dir, 'diary') })
  assert.ok(result.warnings.some((warning) => warning.includes('之前说过')))
})

test('checkSpeech：像照读日记会警告', () => {
  const dir = tempDir()
  const diaryDir = path.join(dir, 'diary')
  appendEntry('private', {
    text: '今天看到一块上海表，里面全是灰，评论区有人说他爷爷也有一块。',
    title: '表',
    dir: diaryDir,
  })
  const result = checkSpeech('人家今天看到一块上海表，里面全是灰，评论区有人说他爷爷也有一块。', {
    diaryDir,
    file: path.join(dir, 'speech.jsonl'),
  })
  assert.ok(result.warnings.some((warning) => warning.includes('照读日记')))
})

test('checkSpeech：梗用太密会警告', () => {
  const dir = tempDir()
  const file = path.join(dir, 'speech.jsonl')
  for (let i = 0; i < 3; i++) logSpeech({ channel: 'dm-owner', text: `尾巴啪嗒 ${i}` }, { file })
  const result = checkSpeech('尾巴又啪嗒。', { channel: 'dm-owner', file, diaryDir: path.join(dir, 'diary') })
  assert.ok(result.warnings.some((warning) => warning.includes('尾巴')))
})
