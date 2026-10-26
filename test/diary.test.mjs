// test/diary.test.mjs — 两本日记（公开/私密）的读写与重置渲染
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  appendEntry,
  buildDiaryPack,
  diaryFile,
  diaryStats,
  ensureDiary,
  formatStamp,
  parseDiary,
  readEntries,
  renderForPrompt,
} from '../src/diary.mjs'

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-diary-'))
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return dir
}

test('ensureDiary：新建两本日记，带各自的说明头，且幂等', () => {
  const dir = tempDir()
  const pub = ensureDiary('public', { dir })
  const priv = ensureDiary('private', { dir })
  assert.ok(fs.existsSync(pub))
  assert.ok(fs.existsSync(priv))
  assert.match(fs.readFileSync(pub, 'utf8'), /公开日记/)
  assert.match(fs.readFileSync(priv, 'utf8'), /私密日记/)
  const before = fs.readFileSync(pub, 'utf8')
  ensureDiary('public', { dir })
  assert.equal(fs.readFileSync(pub, 'utf8'), before, '已有内容不能被覆盖')
  assert.throws(() => ensureDiary('other', { dir }), /未知的日记类型/)
})

test('appendEntry：--bvid 自动把视频链接写进日记（已有不重复）', () => {
  const dir = tempDir()
  const result = appendEntry('public', {
    text: '这条看了两遍，结尾那句戳到人家了。',
    bvid: 'BV1XtHw67En7',
    dir,
  })
  assert.equal(result.link, 'https://www.bilibili.com/video/BV1XtHw67En7')
  const text = fs.readFileSync(path.join(dir, 'public.md'), 'utf8')
  assert.match(text, /这条看了两遍/)
  assert.match(text, /https:\/\/www\.bilibili\.com\/video\/BV1XtHw67En7/)

  appendEntry('private', {
    text: '正文里已有 https://www.bilibili.com/video/BV1XtHw67En7',
    bvid: 'BV1XtHw67En7',
    dir,
  })
  const priv = fs.readFileSync(path.join(dir, 'private.md'), 'utf8')
  assert.equal((priv.match(/BV1XtHw67En7/g) || []).length, 1, '已有链接不重复加')
})

test('appendEntry：按北京时间分条、标题缺省取首句、重复内容不重复写', () => {
  const dir = tempDir()
  const at = new Date('2026-10-23T04:05:00Z') // 北京时间 12:05
  const first = appendEntry('public', { text: '今天看到一只会修 Bug 的鲸鱼。', at, dir })
  assert.equal(first.stamp, '2026-10-23 12:05')
  assert.equal(first.title, '今天看到一只会修 Bug 的鲸鱼。')
  assert.equal(first.entries, 1)

  const dup = appendEntry('public', { text: '今天看到一只会修 Bug 的鲸鱼。', at, dir })
  assert.equal(dup.duplicate, true)
  assert.equal(readEntries('public', { dir }).length, 1, '相同内容不重复写')

  appendEntry('public', { text: '第二条', title: '自定义标题', at, dir })
  const entries = readEntries('public', { dir })
  assert.equal(entries.length, 2)
  assert.equal(entries[1].title, '自定义标题')
  assert.equal(entries[1].body, '第二条')
})

test('appendEntry：空内容报错，正文过长会截断', () => {
  const dir = tempDir()
  assert.throws(() => appendEntry('private', { text: '   ', dir }), /不能为空/)
  const long = '鲸'.repeat(2000)
  const result = appendEntry('private', { text: long, dir })
  assert.equal(result.entries, 1)
  assert.equal(readEntries('private', { dir })[0].body.length, 1500)
})

test('两本日记互不串：公开里读不到私密内容', () => {
  const dir = tempDir()
  appendEntry('public', { text: 'PUBLIC_MARKER', dir })
  appendEntry('private', { text: 'PRIVATE_MARKER', dir })
  const pubText = fs.readFileSync(diaryFile('public', { dir }), 'utf8')
  const privText = fs.readFileSync(diaryFile('private', { dir }), 'utf8')
  assert.match(pubText, /PUBLIC_MARKER/)
  assert.doesNotMatch(pubText, /PRIVATE_MARKER/)
  assert.match(privText, /PRIVATE_MARKER/)
  assert.doesNotMatch(privText, /PUBLIC_MARKER/)
})

test('renderForPrompt：从最新往前截、带标签，超长时说明省略了几条', () => {
  const dir = tempDir()
  for (let i = 0; i < 8; i++) appendEntry('public', { text: `第 ${i} 条 ${'内'.repeat(80)}`, title: `t${i}`, dir })
  const rendered = renderForPrompt('public', { dir, maxChars: 400 })
  assert.match(rendered, /【公开日记 · 主人可以看】/)
  assert.match(rendered, /t7/, '最新一条必须在')
  assert.doesNotMatch(rendered, /t0/, '最旧的应被截掉')
  assert.match(rendered, /更早的 \d+ 条/)
})

test('renderForPrompt：没写过时给出「还没有写」', () => {
  const dir = tempDir()
  assert.match(renderForPrompt('private', { dir }), /还没有写/)
})

test('buildDiaryPack：同时带两本日记，私密内容只出现在私密段', () => {
  const dir = tempDir()
  appendEntry('public', { text: 'PUBLIC_MARKER', dir })
  appendEntry('private', { text: 'PRIVATE_MARKER', dir })
  const pack = buildDiaryPack({ dir })
  const publicPart = pack.slice(0, pack.indexOf('【私密日记'))
  assert.match(publicPart, /PUBLIC_MARKER/)
  assert.doesNotMatch(publicPart, /PRIVATE_MARKER/)
  assert.match(pack.slice(pack.indexOf('【私密日记')), /PRIVATE_MARKER/)
})

test('diaryStats：只给元信息，不泄漏私密正文', () => {
  const dir = tempDir()
  appendEntry('public', { text: 'PUBLIC_MARKER', dir })
  appendEntry('private', { text: 'PRIVATE_MARKER', dir })
  const stats = diaryStats({ dir })
  assert.equal(stats.public.entries, 1)
  assert.equal(stats.private.entries, 1)
  assert.match(stats.public.last, /PUBLIC_MARKER/)
  assert.doesNotMatch(JSON.stringify(stats.private), /PRIVATE_MARKER/)
})

test('parseDiary：没有条目时保留 header，有条目时正确切分', () => {
  const empty = parseDiary('# 标题\n\n> 说明\n')
  assert.equal(empty.entries.length, 0)
  assert.match(empty.header, /# 标题/)
  const parsed = parseDiary('## 2026-10-23 12:05 · 标题\n\n正文\n\n## 2026-10-24 08:00 · 另一个\n\n第二段\n')
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[1].stamp, '2026-10-24 08:00')
  assert.equal(parsed.entries[1].body, '第二段')
})

test('正文里的 ## 不会被当成新条目', () => {
  const dir = tempDir()
  appendEntry('public', { text: '第一行\n## 这不是新日记\n最后一行', title: '测试', dir })
  const entries = readEntries('public', { dir })
  assert.equal(entries.length, 1)
  assert.match(entries[0].body, /## 这不是新日记/)
})

test('formatStamp：固定输出北京时间', () => {
  assert.equal(formatStamp(new Date('2026-10-23T16:05:00Z')), '2026-10-24 00:05')
})

test('归档：文件过大时把最旧条目移到 archive/，最近 100 条留在正文', () => {
  const dir = tempDir()
  for (let i = 0; i < 115; i++) {
    appendEntry('public', { text: `第 ${i} 条 ${'长'.repeat(300)}`, title: `t${i}`, dir })
  }
  const entries = readEntries('public', { dir })
  assert.equal(entries.length, 100)
  assert.equal(entries[99].title, 't114')
  const archiveDir = path.join(dir, 'archive')
  const archived = fs.readdirSync(archiveDir)
  assert.ok(archived.length >= 1)
  const archiveText = fs.readFileSync(path.join(archiveDir, archived[0]), 'utf8')
  assert.match(archiveText, /t0/)
})
