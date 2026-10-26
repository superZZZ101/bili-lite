// test/dynamic.test.mjs — 动态：文字 / 图片 / 视频分享 / 隐私检查
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  checkDynamicPrivacy,
  checkImagePath,
  deleteDynamic,
  postDynamic,
} from '../src/dynamic.mjs'
import { STATE_DIR } from '../src/state.mjs'

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-dyn-'))
  test.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })
  return dir
}

test('checkDynamicPrivacy：普通日记碎片可以通过', () => {
  const result = checkDynamicPrivacy('今天首页有点吵，人家看了一会儿就关了。')
  assert.equal(result.ok, true)
})

test('checkDynamicPrivacy：cookie / key 这类东西直接拦', () => {
  assert.equal(checkDynamicPrivacy('SESSDATA=abcdef').ok, false)
  assert.equal(checkDynamicPrivacy('sk-1234567890abcdef').ok, false)
})

test('postDynamic：纯文字 dry-run', async () => {
  const result = await postDynamic('表停在三点，海还在走。', { dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.text, '表停在三点，海还在走。')
  assert.equal(result.kind, 'text')
})

test('postDynamic：带 bvid 时自动把视频链接写进动态（文字+链接）', async () => {
  const result = await postDynamic('这个人家看了两遍。', { dryRun: true, bvid: 'BV186pc65E68' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'text-link')
  assert.equal(result.bvid, 'BV186pc65E68')
  assert.equal(result.link, 'https://www.bilibili.com/video/BV186pc65E68')
  assert.match(result.text, /这个人家看了两遍。/)
  assert.match(result.text, /https:\/\/www\.bilibili\.com\/video\/BV186pc65E68/)
})

test('postDynamic：正文里已经有链接就不重复加', async () => {
  const text = '看了，https://www.bilibili.com/video/BV186pc65E68 真的好看。'
  const result = await postDynamic(text, { dryRun: true, bvid: 'BV186pc65E68' })
  assert.equal(result.ok, true)
  assert.equal(result.text, text)
})

test('postDynamic：图片 dry-run 带 images', async () => {
  const result = await postDynamic('配一张。', { dryRun: true, image: 'C:/tmp/a.png' })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'image')
  assert.deepEqual(result.images, ['C:/tmp/a.png'])
})

test('postDynamic：视频链接和图片不能同时带', async () => {
  const result = await postDynamic('x', { dryRun: true, bvid: 'BV186pc65E68', image: 'C:/tmp/a.png' })
  assert.equal(result.ok, false)
})

test('postDynamic：空内容拒绝', async () => {
  const result = await postDynamic('   ', { dryRun: true })
  assert.equal(result.ok, false)
})

test('checkImagePath：只收 png/jpg/gif，且拒绝私信图片/日记目录', () => {
  const dir = tempDir()
  const okFile = path.join(dir, 'frame.png')
  fs.writeFileSync(okFile, Buffer.alloc(2048, 1))
  assert.equal(checkImagePath(okFile).ok, true)

  const badExt = path.join(dir, 'frame.webp')
  fs.writeFileSync(badExt, Buffer.alloc(2048, 1))
  assert.equal(checkImagePath(badExt).ok, false)

  const missing = path.join(dir, 'nope.png')
  assert.equal(checkImagePath(missing).ok, false)

  // 放在 state/inbox-images 下，模拟主人私信图片（不应该允许）
  const blockedDir = path.join(STATE_DIR, 'inbox-images')
  fs.mkdirSync(blockedDir, { recursive: true })
  const blocked = path.join(blockedDir, 'private-frame.png')
  fs.writeFileSync(blocked, Buffer.alloc(2048, 1))
  assert.equal(checkImagePath(blocked).ok, false)
  fs.unlinkSync(blocked)
})

test('deleteDynamic：缺 id 拒绝', async () => {
  const result = await deleteDynamic('')
  assert.equal(result.ok, false)
})
