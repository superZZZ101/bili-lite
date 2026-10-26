// test/comments.test.mjs — 评论台账：每条评论记「视频链接 + 评论内容」
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  appendComment,
  bvidUrl,
  commentsFile,
  commentsStats,
  ensureComments,
  parseComments,
  readComments,
  recentComments,
} from '../src/comments.mjs'

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-comments-'))
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return path.join(dir, 'comments.md')
}

test('appendComment：写进 Markdown，格式是「时间 → 视频链接 → 评论内容」', () => {
  const file = tempFile()
  const result = appendComment({
    bvid: 'BV1xx411c7mD',
    text: '这条讲得实在，看完心里有个钩子。',
    at: new Date('2026-10-26T11:45:00+08:00'),
    file,
  })
  assert.equal(result.ok, true)
  assert.equal(result.url, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(result.stamp, '2026-10-26 11:45')

  const text = fs.readFileSync(file, 'utf8')
  assert.match(text, /^# 她发过的评论/, '有文件头')
  assert.match(text, /## 2026-10-26 11:45\nhttps:\/\/www\.bilibili\.com\/video\/BV1xx411c7mD\n这条讲得实在，看完心里有个钩子。/)
})

test('appendComment：多条按顺序追加，能解析回 url + text', () => {
  const file = tempFile()
  appendComment({ bvid: 'BV1xx411c7mD', text: '第一条', at: new Date('2026-10-26T09:00:00+08:00'), file })
  appendComment({ bvid: 'BV1yy411c7mE', text: '第二条\n第二行', at: new Date('2026-10-26T10:30:00+08:00'), file })
  const entries = readComments({ file })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].bvid, 'BV1xx411c7mD')
  assert.equal(entries[0].text, '第一条')
  assert.equal(entries[1].bvid, 'BV1yy411c7mE')
  assert.equal(entries[1].text, '第二条\n第二行')
  assert.equal(entries[1].stamp, '2026-10-26 10:30')
})

test('appendComment：同一条视频 + 同一段话重复写不会记两次（发送重试）', () => {
  const file = tempFile()
  appendComment({ bvid: 'BV1xx411c7mD', text: '同一句', file })
  const again = appendComment({ bvid: 'BV1xx411c7mD', text: '同一句', file })
  assert.equal(again.duplicate, true)
  assert.equal(readComments({ file }).length, 1)
  // 换个视频就可以同样的话再记一条
  appendComment({ bvid: 'BV1yy411c7mE', text: '同一句', file })
  assert.equal(readComments({ file }).length, 2)
})

test('bvidUrl：只认 BV 号，非法直接报错', () => {
  assert.equal(bvidUrl('BV1xx411c7mD'), 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.throws(() => bvidUrl('av12345'), /bvid 不合法/)
  assert.throws(() => bvidUrl(''), /bvid 不合法/)
  assert.throws(() => appendComment({ bvid: 'xx', text: 'x', file: tempFile() }), /bvid 不合法/)
})

test('appendComment：空内容报错，不建脏条目', () => {
  const file = tempFile()
  assert.throws(() => appendComment({ bvid: 'BV1xx411c7mD', text: '   ', file }), /评论内容不能为空/)
  assert.equal(readComments({ file }).length, 0)
})

test('ensureComments：幂等，已有内容不覆盖', () => {
  const file = tempFile()
  ensureComments({ file })
  appendComment({ bvid: 'BV1xx411c7mD', text: '别被覆盖', file })
  ensureComments({ file })
  assert.match(fs.readFileSync(file, 'utf8'), /别被覆盖/)
})

test('commentsStats / recentComments：条数、视频数、最近几条', () => {
  const file = tempFile()
  appendComment({ bvid: 'BV1xx411c7mD', text: 'a', file })
  appendComment({ bvid: 'BV1xx411c7mD', text: 'b', file })
  appendComment({ bvid: 'BV1yy411c7mE', text: 'c', file })
  const stats = commentsStats({ file })
  assert.equal(stats.entries, 3)
  assert.equal(stats.videos, 2)
  assert.equal(stats.file, file)
  assert.match(stats.last, /BV1yy411c7mE/)
  assert.equal(recentComments({ limit: 2, file }).length, 2)
  assert.equal(recentComments({ limit: 2, file })[1].text, 'c')
})

test('parseComments：没有条目时返回 header，不抛错', () => {
  const parsed = parseComments('# 只有头\n\n说明\n')
  assert.equal(parsed.entries.length, 0)
  assert.match(parsed.header, /只有头/)
})

test('commentsFile：默认落在 state/comments.md', () => {
  assert.match(commentsFile(), /state[\\/]comments\.md$/)
})
