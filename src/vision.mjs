// src/vision.mjs — 本地 Qwen-VL 识图，给 DeepSeek 的画面理解做第二意见
//
// 为什么：DeepSeek 的识图对细节/屏幕文字不稳定。本地 Ollama 的 Qwen-VL 看同一批
// 截图/联络表，给一份文字描述；两份一起交给 agent 参考（本地抓细节，DeepSeek 做整体）。
//
// 约定：
// - 只走 Ollama 的 /api/chat（images 传 base64），不依赖 DSH 插件；
// - 任何失败都不抛到上层（describeImages 逐张记录 ok/message），不影响抽帧主流程；
// - 模型默认 qwen3-vl:8b，可用 BILI_VISION_MODEL 或 --vision-model 覆盖；
//   BILI_VISION=0 或 --no-vision 可整体关掉。
import fs from 'node:fs'

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434'
export const DEFAULT_VISION_MODEL = process.env.BILI_VISION_MODEL || 'qwen3-vl:8b'

/**
 * 给本地视觉的提示词。
 * @param {{kind?:'frame'|'contact', count?:number}} opts
 */
export function visionPrompt({ kind = 'frame', count = 1 } = {}) {
  if (kind === 'contact') {
    return (
      `这是一张 B 站视频截图的联络表：${count} 格，从左到右、从上到下按时间排列，` +
      '每格左上角标着时间（mm:ss，或带十分之一秒的 mm:ss.d）。\n' +
      '请逐格用一句中文（不超过 20 字）写：画面里是谁/在做什么、屏幕上看得清的字；' +
      '看不清就说看不清，不要编；不要评价视频好坏，只描述看见的东西。'
    )
  }
  return (
    '这是 B 站视频的一张截图。用两三句中文描述：画面里是谁/在做什么、' +
    '屏幕上能看清的文字、场景是什么；看不清就说看不清，不要编。'
  )
}

/**
 * 让本地 Qwen-VL 看一张图。
 * @param {string} file 图片路径
 * @param {{model?:string, prompt?:string, baseUrl?:string, timeoutMs?:number, fetchImpl?:Function}} opts
 * @returns {Promise<string>} 模型输出的中文描述
 */
export async function describeImage(
  file,
  {
    model = DEFAULT_VISION_MODEL,
    prompt = visionPrompt(),
    baseUrl = DEFAULT_OLLAMA_URL,
    timeoutMs = 180_000,
    // 4096 是 Ollama 默认上下文：Qwen3-VL 会先想 1.9K~3K token，
    // 4096 下经常「想满就截断」，content 为空；8K 才够「思考 + 逐格描述」。
    numCtx = 8192,
    numPredict = 6000,
    fetchImpl = fetch,
  } = {},
) {
  const image = fs.readFileSync(file).toString('base64')
  const started = Date.now()

  async function ask(budget) {
    // timeoutMs 是「这一张图的总预算」，不是每次 HTTP 尝试各给一份：
    // content 为空重试时也要共用同一份时间，避免 2 张表跑出 500s。
    const left = timeoutMs - (Date.now() - started)
    if (left < 1000) throw new Error('识图超时（总预算用完）')
    const response = await fetchImpl(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        // Qwen3-VL 即使 think=false 也常先想一段；预算要够它想完再写描述
        think: false,
        messages: [{ role: 'user', content: prompt, images: [image] }],
        options: { temperature: 0.2, num_predict: budget, num_ctx: numCtx },
      }),
      signal: AbortSignal.timeout(left),
    })
    if (!response.ok) throw new Error(`Ollama 返回 HTTP ${response.status}`)
    const data = await response.json()
    const text = data && data.message && typeof data.message.content === 'string' ? data.message.content.trim() : ''
    return text
  }

  let text = await ask(numPredict)
  if (!text) text = await ask(Math.max(numPredict, 6500))
  if (!text) throw new Error('Ollama 没有返回文字（思考占满了预算）')
  return text
}

/**
 * 并发看多张图，保持输入顺序；单张失败不影响其它张。
 * @param {string[]} files
 * @param {{concurrency?:number, describe?:Function, prompts?:string[]} & object} opts 其余参数透传给 describeImage
 * @returns {Promise<Array<{ok:boolean, file:string, text?:string, message?:string}>>}
 */
export async function describeImages(files, { concurrency = 2, describe = describeImage, prompts, ...opts } = {}) {
  const results = new Array(files.length)
  let cursor = 0
  const width = Math.max(1, Math.min(concurrency, files.length || 1))
  const workers = Array.from({ length: width }, async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= files.length) return
      const prompt = Array.isArray(prompts) ? prompts[index] : undefined
      const callOpts = prompt === undefined ? opts : { ...opts, prompt }
      try {
        results[index] = { ok: true, file: files[index], text: await describe(files[index], callOpts) }
      } catch (error) {
        results[index] = { ok: false, file: files[index], message: error.message }
      }
    }
  })
  await Promise.all(workers)
  return results
}

/** Ollama 是否在跑、目标模型有没有（只做快速探测，失败不抛）。 */
export async function visionStatus({ baseUrl = DEFAULT_OLLAMA_URL, model = DEFAULT_VISION_MODEL, fetchImpl = fetch } = {}) {
  try {
    const response = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) return { ok: false, message: `Ollama HTTP ${response.status}` }
    const data = await response.json()
    const names = (data.models || []).map((item) => item.name)
    return { ok: names.includes(model), models: names, model }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}
