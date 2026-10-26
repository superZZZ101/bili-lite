// test/vision.test.mjs — 本地 Qwen-VL 识图的提示词与并发/容错
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

import { DEFAULT_VISION_MODEL, describeImage, describeImages, visionPrompt } from '../src/vision.mjs'

test('visionPrompt：联络表要求逐格、带时间戳、不许编', () => {
  const prompt = visionPrompt({ kind: 'contact', count: 9 })
  assert.match(prompt, /9 格/)
  assert.match(prompt, /mm:ss/)
  assert.match(prompt, /逐格/)
  assert.match(prompt, /看不清就说看不清，不要编/)
})

test('visionPrompt：单帧是两三句描述', () => {
  const prompt = visionPrompt()
  assert.match(prompt, /一张截图/)
  assert.match(prompt, /两三句/)
  assert.match(prompt, /不要编/)
})

test('默认模型是 qwen3-vl:8b', () => {
  assert.equal(DEFAULT_VISION_MODEL, process.env.BILI_VISION_MODEL || 'qwen3-vl:8b')
})

test('describeImages：保持输入顺序，单张失败不影响其它', async () => {
  const calls = []
  const results = await describeImages(['a', 'b', 'c'], {
    concurrency: 2,
    describe: async (file) => {
      calls.push(file)
      if (file === 'b') throw new Error('boom')
      return `text:${file}`
    },
  })
  assert.deepEqual(
    results.map((item) => item.ok),
    [true, false, true],
  )
  assert.equal(results[0].text, 'text:a')
  assert.equal(results[1].message, 'boom')
  assert.equal(results[2].text, 'text:c')
  assert.equal(calls.length, 3)
})

test('describeImages：并发不超过上限，且确实并发', async () => {
  let active = 0
  let peak = 0
  await describeImages(['1', '2', '3', '4', '5'], {
    concurrency: 2,
    describe: async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return 'ok'
    },
  })
  assert.equal(peak, 2)
})

test('describeImages：空列表直接返回', async () => {
  const results = await describeImages([], { describe: async () => 'x' })
  assert.deepEqual(results, [])
})

test('describeImages：prompts 按图逐张覆盖默认提示词', async () => {
  const seen = []
  await describeImages(['a', 'b'], {
    concurrency: 1,
    prompts: ['p0', 'p1'],
    describe: async (file, opts) => {
      seen.push([file, opts.prompt])
      return 'x'
    },
  })
  assert.deepEqual(seen, [
    ['a', 'p0'],
    ['b', 'p1'],
  ])
})

test('describeImage：content 为空时自动加预算重试一次', async () => {
  const budgets = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    budgets.push(body.options.num_predict)
    return {
      ok: true,
      json: async () => ({ message: { content: budgets.length === 1 ? '' : '第二遍才有字' } }),
    }
  }
  const text = await describeImage(fileURLToPath(import.meta.url), { fetchImpl })
  assert.equal(text, '第二遍才有字')
  assert.equal(budgets.length, 2)
  assert.ok(budgets[1] >= budgets[0])
})

test('describeImage：默认 8K 上下文 + 足够 Qwen 想完的预算', async () => {
  let body
  const fetchImpl = async (url, init) => {
    body = JSON.parse(init.body)
    return { ok: true, json: async () => ({ message: { content: 'ok' } }) }
  }
  await describeImage(fileURLToPath(import.meta.url), { fetchImpl })
  assert.equal(body.options.num_ctx, 8192)
  assert.ok(body.options.num_predict >= 6000)
})
