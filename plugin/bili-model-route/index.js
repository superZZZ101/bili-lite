// bili-model-route — DSH 宿主插件：让 B 站相关会话固定走 deepseekapi 的 flash4.1。
//
// 为什么需要它：DSH 的 agent-default-model 是「整个 profile 一个默认值」，
// 任何会话里手动换一次模型都会改写它；B 站会话（私信 / 生活 / 陌生人）新建时
// 就会跟着漂。这个插件只在 agent/request 这个 waterfall 上，对 sessionId 以
// `bili-lite` 开头的会话把 provider/model 改成 deepseekapi / deepseek-v4.1-flash-1017，
// 其它会话原样放行，也不改全局默认。
//
// 生效方式：cordis.patch.yml 里 insert 这一行；宿主 recompose 后即可。
// 关掉：给那一行加 `disabled: true`（或删掉），不影响别的插件。
// 换模型：改下面 TARGET 三个常量，重新部署本文件再触发一次 recompose。
//
// 注意：
// 1) 这是「固定路由」，会覆盖在 B 站会话里手动选的模型；如果以后想恢复手动选择，
//    停用本插件即可（会话里最后一次 request/header 仍会显示实际用过的模型）。
// 2) 只改路由，不改 maxTokens / 工具 / 权限；deepseekapi 这个 provider 在
//    cordis.patch.yml 的 llm-pi-ai 段里配置，若那段被删掉，本插件会让 B 站会话报错，
//    届时停用本插件即可回退到全局默认。
// 3) 失败不拦请求：任何异常都原样返回 next() 的结果。

import fs from 'node:fs'
import path from 'node:path'

export const name = 'bili-model-route'

/** 只接管这些 sessionId（B 站私信 / 生活 / 陌生人 / 自检会话都以此开头）。 */
const SESSION_PREFIX = process.env.BILI_MODEL_PREFIX || 'bili-lite'

/** 目标路由：deepseekapi 的 flash4.1。该模型只声明了 max 档 reasoningEffort。 */
const TARGET = {
  provider: process.env.BILI_MODEL_PROVIDER || 'deepseekapi',
  model: process.env.BILI_MODEL_ID || 'deepseek-v4.1-flash-1017',
  reasoningEffort: process.env.BILI_MODEL_EFFORT || 'max',
}

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh')
const LOG_FILE = path.join(DSH_HOME, 'bili-model-route.log')
const LOG_MAX_BYTES = 512 * 1024

/** 追加一行日志；失败静默（日志不是功能）。 */
function log(line) {
  try {
    const stamp = new Date().toISOString()
    try {
      if (fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) fs.writeFileSync(LOG_FILE, '')
    } catch {
      /* 文件还不存在 */
    }
    fs.appendFileSync(LOG_FILE, `[${stamp}] ${line}\n`)
  } catch {
    /* 忽略 */
  }
}

function sessionIdOf(payload) {
  const agent = payload && payload.agent
  if (!agent) return ''
  return String(agent.id || agent.sessionId || '')
}

export function apply(ctx) {
  // 同一会话同一轮只记一次，避免每个 step 刷一行
  const logged = new Set()

  // prepend：永远排在 agent 自己的 model-selection 监听器之前（最外层），保证最后返回的是我们的路由；
  // 否则「agent 先创建、插件后热加载」时，会被会话里记住的模型盖回去。
  ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    if (!config) return config

    try {
      const sessionId = sessionIdOf(payload)
      if (!sessionId.startsWith(SESSION_PREFIX)) return config

      // 已经是目标路由就原样放行（包括用户手动选对的情况）
      if (
        config.provider === TARGET.provider &&
        config.model === TARGET.model &&
        String(config.reasoningEffort || '') === TARGET.reasoningEffort
      ) {
        return config
      }

      const turn = payload && payload.turn
      const key = `${sessionId}:${turn === undefined ? '' : turn}`
      if (!logged.has(key)) {
        logged.add(key)
        if (logged.size > 1000) logged.clear()
        log(
          `${sessionId} turn=${turn === undefined ? '?' : turn} ` +
            `${config.provider || '-'}/${config.model || '-'}@${config.reasoningEffort || '-'} ` +
            `-> ${TARGET.provider}/${TARGET.model}@${TARGET.reasoningEffort}`,
        )
      }

      return {
        ...config,
        provider: TARGET.provider,
        model: TARGET.model,
        reasoningEffort: TARGET.reasoningEffort,
      }
    } catch {
      // 路由自己出错不能拖垮 B 站回复：原样用宿主给的配置
      return config
    }
  }, { prepend: true })
}

export default { name, apply }
