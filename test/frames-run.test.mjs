// test/frames-run.test.mjs — 抽帧后的 meta / 分批识图 / 进度读取
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { readRunMeta, runVisionForRun, visionStatusForRun, writeRunMeta } from '../src/frames.mjs'

function makeRun() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-frames-'))
  fs.writeFileSync(path.join(dir, 'contact-01.jpg'), 'x')
  fs.writeFileSync(path.join(dir, 'contact-02.jpg'), 'x')
  writeRunMeta(dir, {
    bvid: 'BVtest',
    title: '测试视频',
    duration: 8,
    mode: 'dense',
    source: 'ffmpeg',
    fps: 1.2,
    count: 18,
    totalFrames: 18,
    sheets: [
      { index: 1, path: path.join(dir, 'contact-01.jpg'), count: 9, from: '00:00.0', to: '00:06.7' },
      { index: 2, path: path.join(dir, 'contact-02.jpg'), count: 9, from: '00:07.5', to: '00:14.2' },
    ],
    frames: [],
  })
  return dir
}

test('writeRunMeta / readRunMeta：保留联络表清单，不写 vision', () => {
  const dir = makeRun()
  const meta = readRunMeta(dir)
  assert.equal(meta.bvid, 'BVtest')
  assert.equal(meta.sheets.length, 2)
  assert.equal(meta.sheets[1].count, 9)
  assert.equal(meta.vision, undefined)
})

test('runVisionForRun：每次 limit 张，增量落盘，第二次跳过已成功', async () => {
  const dir = makeRun()
  const calls = []
  const describe = async (file) => {
    calls.push(file)
    return `描述 ${path.basename(file)}`
  }
  const first = await runVisionForRun(dir, { limit: 1, describe })
  assert.equal(first.ok, true)
  assert.equal(first.done, 1)
  assert.equal(first.remaining, 1)
  assert.equal(first.processed, 1)
  assert.equal(calls.length, 1)

  const second = await runVisionForRun(dir, { limit: 5, describe })
  assert.equal(second.done, 2)
  assert.equal(second.remaining, 0)
  assert.equal(second.processed, 1)
  assert.equal(calls.length, 2)

  const state = JSON.parse(fs.readFileSync(path.join(dir, 'vision.json'), 'utf8'))
  assert.equal(state.total, 2)
  assert.equal(state.items['2'].ok, true)
})

test('visionStatusForRun：只读进度和已完成文本，不重复调用模型', async () => {
  const dir = makeRun()
  let calls = 0
  await runVisionForRun(dir, {
    limit: 1,
    describe: async () => {
      calls += 1
      return '表 1 的画面'
    },
  })
  const status = visionStatusForRun(dir)
  assert.equal(status.done, 1)
  assert.equal(status.remaining, 1)
  assert.match(status.text, /【表 1】/)
  assert.match(status.text, /表 1 的画面/)
  assert.equal(calls, 1)
})

test('runVisionForRun：失败的表会留在 pending，下次重试', async () => {
  const dir = makeRun()
  let attempt = 0
  const describe = async () => {
    attempt += 1
    if (attempt === 1) throw new Error('临时失败')
    return '第二次成功'
  }
  const first = await runVisionForRun(dir, { limit: 2, describe })
  assert.equal(first.done, 1)
  assert.equal(first.remaining, 1)
  const second = await runVisionForRun(dir, { limit: 2, describe })
  assert.equal(second.done, 2)
  assert.equal(second.remaining, 0)
  assert.equal(attempt, 3)
})
