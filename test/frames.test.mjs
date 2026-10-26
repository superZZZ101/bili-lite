// test/frames.test.mjs — 视频抽帧的选帧/裁图坐标
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DENSE_FPS,
  DENSE_MAX_FRAMES,
  DENSE_PER_SHEET,
  denseDedupe,
  denseFps,
  frameTime,
  frameTimePrecise,
  parseFpsExpr,
  sampleFramesEvenly,
  selectDensePlan,
  selectFramePlan,
} from '../src/frames.mjs'

function shot(index = []) {
  return {
    img_x_len: 10,
    img_y_len: 10,
    img_x_size: 480,
    img_y_size: 270,
    image: ['//bimp.hdslb.com/sheet-0001.jpg'],
    index,
  }
}

test('frameTime：秒数转 mm:ss', () => {
  assert.equal(frameTime(0), '00:00')
  assert.equal(frameTime(66), '01:06')
  assert.equal(frameTime(209), '03:29')
})

test('frameTimePrecise：1.2 帧/秒 的每格时间都唯一', () => {
  assert.equal(frameTimePrecise(0), '00:00.0')
  assert.equal(frameTimePrecise(5.833), '00:05.8')
  assert.equal(frameTimePrecise(59.96), '01:00.0')
  assert.equal(frameTimePrecise(78.33), '01:18.3')
  const labels = Array.from({ length: 9 }, (_, i) => frameTimePrecise(i / 1.2))
  assert.equal(new Set(labels).size, labels.length)
})

test('selectFramePlan：29 帧里选 4 帧，避开片头片尾', () => {
  const index = [0, 0, 8, 16, 25, 33, 41, 50, 58, 66, 75, 82, 91, 100, 108, 116, 122, 129, 138, 146, 153, 161, 167, 175, 182, 189, 196, 201, 209]
  const plan = selectFramePlan(shot(index), { count: 4, duration: 217 })
  assert.deepEqual(plan.map((frame) => frame.frameIndex), [1, 9, 17, 25])
  assert.deepEqual(plan.map((frame) => frame.at), [0, 66, 129, 189])
  assert.equal(plan[1].x, 4320)
  assert.equal(plan[2].x, 3360)
  assert.equal(plan[2].y, 270)
  assert.equal(plan[3].y, 540)
})

test('selectFramePlan：count=1 取中间一帧', () => {
  const index = Array.from({ length: 29 }, (_, i) => i * 7)
  const plan = selectFramePlan(shot(index), { count: 1, duration: 200 })
  assert.equal(plan.length, 1)
  assert.ok(plan[0].frameIndex >= 10 && plan[0].frameIndex <= 16)
})

test('selectFramePlan：没有 index 时按时长均匀估算', () => {
  const plan = selectFramePlan(shot([]), { count: 3, duration: 120 })
  assert.equal(plan.length, 3)
  assert.deepEqual(plan.map((frame) => frame.frameIndex), [4, 47, 89])
  assert.equal(plan[0].at, 5)
  assert.equal(plan[2].at, 107)
  assert.equal(plan[0].sheetIndex, 0)
})

test('DENSE_FPS：1.2 帧/秒，联络表每张 9 格', () => {
  assert.equal(DENSE_FPS, 1.2)
  assert.equal(DENSE_PER_SHEET, 9)
})

test('parseFpsExpr：1.2 / 120/100 / 63/100 都认，非法回退默认 1.2', () => {
  assert.deepEqual(parseFpsExpr('1.2'), { expr: '1.2', fps: 1.2 })
  assert.deepEqual(parseFpsExpr('120/100'), { expr: '120/100', fps: 1.2 })
  assert.deepEqual(parseFpsExpr('63/100'), { expr: '63/100', fps: 0.63 })
  assert.equal(parseFpsExpr('2').fps, 2)
  assert.equal(parseFpsExpr('0.5').fps, 0.5)
  // 非法 / 越界 → 默认 1.2
  assert.equal(parseFpsExpr('abc').fps, 1.2)
  assert.equal(parseFpsExpr('0').fps, 1.2)
  assert.equal(parseFpsExpr('999').fps, 1.2)
  assert.equal(parseFpsExpr('').fps, 1.2)
  assert.equal(parseFpsExpr('abc', { expr: '1.2', fps: 1.2 }).fps, 1.2)
})

test('denseFps：BILI_DENSE_FPS 环境变量生效，默认 1.2', () => {
  const prev = process.env.BILI_DENSE_FPS
  try {
    delete process.env.BILI_DENSE_FPS
    assert.equal(denseFps().fps, 1.2)
    assert.equal(denseFps().expr, '6/5')
    process.env.BILI_DENSE_FPS = '0.63'
    assert.equal(denseFps().fps, 0.63)
    assert.equal(denseFps().expr, '0.63')
  } finally {
    if (prev === undefined) delete process.env.BILI_DENSE_FPS
    else process.env.BILI_DENSE_FPS = prev
  }
})

test('denseDedupe：默认关（0），BILI_FRAME_DEDUPE 打开', () => {
  const prev = process.env.BILI_FRAME_DEDUPE
  try {
    delete process.env.BILI_FRAME_DEDUPE
    assert.equal(denseDedupe(), 0)
    process.env.BILI_FRAME_DEDUPE = '6'
    assert.equal(denseDedupe(), 6)
    process.env.BILI_FRAME_DEDUPE = '0'
    assert.equal(denseDedupe(), 0)
    process.env.BILI_FRAME_DEDUPE = 'abc'
    assert.equal(denseDedupe(), 0)
  } finally {
    if (prev === undefined) delete process.env.BILI_FRAME_DEDUPE
    else process.env.BILI_FRAME_DEDUPE = prev
  }
})

test('selectDensePlan：用满 index，重复时间点只留一张', () => {
  const plan = selectDensePlan(shot([0, 0, 5, 10, 15]), { duration: 20 })
  assert.deepEqual(plan.map((frame) => frame.at), [0, 5, 10, 15])
  assert.deepEqual(plan.map((frame) => frame.frameIndex), [0, 2, 3, 4])
  assert.equal(plan[1].x, 960)
  assert.equal(plan[2].time, '00:10')
})

test('selectDensePlan：超过上限时全片均匀抽稀，首尾都保留', () => {
  const index = Array.from({ length: 300 }, (_, i) => i * 2)
  const multiSheet = { ...shot(index), image: ['a', 'b', 'c'] }
  const plan = selectDensePlan(multiSheet, { duration: 600 })
  assert.equal(plan.length, DENSE_MAX_FRAMES)
  assert.equal(plan[0].at, 0)
  assert.equal(plan[plan.length - 1].at, 598)
  // 抽稀后时间点仍然递增
  for (let i = 1; i < plan.length; i++) assert.ok(plan[i].at > plan[i - 1].at)
})

test('sampleFramesEvenly：长视频 516 帧压到 108 帧，首尾都在且递增', () => {
  const frames = Array.from({ length: 516 }, (_, i) => ({ i, at: i }))
  const sampled = sampleFramesEvenly(frames, 108)
  assert.equal(sampled.length, 108)
  assert.equal(sampled[0].i, 0)
  assert.equal(sampled[sampled.length - 1].i, 515)
  for (let i = 1; i < sampled.length; i++) assert.ok(sampled[i].i > sampled[i - 1].i)
})

test('sampleFramesEvenly：不够上限时原样返回；空数组安全', () => {
  const frames = [{ i: 0 }, { i: 1 }, { i: 2 }]
  assert.deepEqual(sampleFramesEvenly(frames, 12), frames)
  assert.equal(sampleFramesEvenly(frames, 12).length, 3)
  assert.deepEqual(sampleFramesEvenly([], 12), [])
})
