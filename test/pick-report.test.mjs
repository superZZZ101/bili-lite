// test/pick-report.test.mjs — pick / report / persona 的单元测试（node:test，无第三方依赖）
// 运行：node --test test/
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  VERDICTS,
  scoreCandidate,
  rankCandidates,
  verdictFor,
  makePick,
  autoPick,
  formatDuration,
} from '../src/pick.mjs'
import { renderCardwall, writeDigest, escapeHtml } from '../src/report.mjs'
import {
  DEFAULT_PERSONA,
  loadPersona,
  buildOneLinerPrompt,
  buildReplyPrompt,
} from '../src/persona.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 一个「正常」候选：15 分钟、点赞率 4% */
function candidate(overrides = {}) {
  const merged = {
    bvid: 'BV1xx411c7mD',
    aid: 10001,
    cid: 20002,
    title: '一个普通视频',
    owner: '某个 UP',
    ownerMid: 30003,
    duration: 900,
    pubdate: 1700000000,
    desc: '普通简介',
    tags: [],
    comments: [],
    cover: '',
    url: '',
    stat: { view: 10000, like: 400, danmaku: 100, reply: 60 },
    ...overrides,
  }
  if (!merged.url) merged.url = `https://www.bilibili.com/video/${merged.bvid}`
  return merged
}

/** 按「字符」数长度，中文算 1 个 */
function charLength(text) {
  return [...String(text)].length
}

// ---------------------------------------------------------------- pick.mjs

test('scoreCandidate：短视频直接低分且 reasons 合规', () => {
  const short = candidate({ duration: 30 })
  const { score, reasons } = scoreCandidate(short, { minDuration: 180, maxDuration: 1800 })
  assert.ok(score < 50, `短视频应低于 50，实际 ${score}`)
  assert.ok(score <= 35, `时长区间之外应被封顶 35，实际 ${score}`)
  assert.equal(verdictFor(score), '不值当')
  assert.ok(reasons.length >= 1 && reasons.length <= 4, 'reasons 应为 1~4 条')
  for (const reason of reasons) {
    assert.ok(charLength(reason) <= 24, `reason 超长：${reason}`)
  }
  assert.ok(reasons.some((r) => r.includes('短')), `reasons 应提到太短：${reasons.join(' / ')}`)

  // 1~3 分钟：落在默认配置（minDuration=60）区间内，但不算舒适区，分数应低于中性
  const brief = scoreCandidate(candidate({ bvid: 'BV1brief', duration: 90 }), {
    minDuration: 60,
    maxDuration: 1800,
  })
  assert.ok(brief.score < 60, `90 秒不应拿高分：${brief.score}`)
})

test('scoreCandidate：15 分钟、互动正常的候选拿到中等分', () => {
  const { score, reasons } = scoreCandidate(candidate(), {})
  assert.ok(score >= 50 && score < 100, `分数应在 50~99，实际 ${score}`)
  assert.ok(Number.isInteger(score), '分数必须是整数')
  assert.equal(verdictFor(score), '可以看')
  assert.ok(reasons.some((r) => r.includes('15 分钟')), `reasons 应包含时长：${reasons}`)
  assert.ok(reasons.some((r) => r.includes('点赞')), `reasons 应包含互动：${reasons}`)
})

test('scoreCandidate：超过 60 分钟扣分（时间成本）', () => {
  const cfg = { minDuration: 180, maxDuration: 7200 }
  const short = scoreCandidate(candidate({ bvid: 'BV1a', duration: 1200 }), cfg).score
  const hour = scoreCandidate(candidate({ bvid: 'BV1b', duration: 4000 }), cfg).score
  assert.ok(hour < short, `4000 秒应低于 1200 秒：${hour} vs ${short}`)
  const longReasons = scoreCandidate(candidate({ bvid: 'BV1b', duration: 4000 }), cfg).reasons
  assert.ok(longReasons.some((r) => r.includes('1 小时')), `reasons 应提到小时：${longReasons}`)
})

test('scoreCandidate：seen 候选直接 -1000，排到最后', () => {
  const seen = { BV1xx411c7mD: { firstSeenAt: '2026-01-01T00:00:00.000Z', action: 'picked' } }
  const byCfg = scoreCandidate(candidate(), { seen })
  assert.equal(byCfg.score, -1000)
  assert.equal(verdictFor(byCfg.score), '不值当')
  assert.ok(byCfg.reasons[0].includes('已看过'))

  const byFlag = scoreCandidate(candidate({ seen: true }), {})
  assert.equal(byFlag.score, -1000)

  // reasons 上限与长度约束在复杂标题下也成立
  const busy = candidate({
    bvid: 'BV1busy',
    title: '2024 最新教程！实测 3 个方法？真的有用吗',
    desc: '关于 AI 的实测记录',
    tags: ['AI', '教程'],
  })
  const busyResult = scoreCandidate(busy, { preferKeywords: ['AI', '教程'] })
  assert.ok(busyResult.reasons.length <= 4)
  for (const reason of busyResult.reasons) assert.ok(charLength(reason) <= 24, reason)
  assert.ok(busyResult.score <= 100 && busyResult.score >= 0, '正常候选分数应在 0~100')
})

test('rankCandidates：过滤 seen/时长、按 bvid 去重、分数降序', () => {
  const a = candidate({ bvid: 'BV1a', pubdate: 1000, title: '普通标题' })
  const aDuplicate = candidate({ bvid: 'BV1a', pubdate: 1000, title: '普通标题（重复抓取）', desc: '' })
  const b = candidate({ bvid: 'BV1b', pubdate: 900, title: '手把手教程：从零搭一个东西' })
  const seenC = candidate({ bvid: 'BV1c', pubdate: 500, duration: 900 })
  const shortD = candidate({ bvid: 'BV1d', pubdate: 400, duration: 40 })
  const longE = candidate({ bvid: 'BV1e', pubdate: 300, duration: 4000 })

  const ranked = rankCandidates(
    [a, aDuplicate, b, seenC, shortD, longE],
    { minDuration: 180, maxDuration: 1800 },
    { BV1c: { firstSeenAt: '2026-01-01T00:00:00.000Z', action: 'skipped' } },
  )

  assert.deepEqual(
    ranked.map((item) => item.bvid),
    ['BV1b', 'BV1a'],
    '应去重、过滤 seen 与区间外候选，并按分数降序',
  )
  assert.ok(ranked[0].score > ranked[1].score)
  assert.equal(ranked.find((item) => item.bvid === 'BV1a').title, '普通标题', '重复 bvid 保留第一次出现的')
  for (const item of ranked) {
    assert.ok(Array.isArray(item.reasons) && item.reasons.length <= 4)
  }
  // 不修改传入对象
  assert.equal(a.score, undefined)

  // 第三个参数省略时，退回读取 cfg.seen
  const viaCfg = rankCandidates([a, seenC], { minDuration: 180, maxDuration: 1800, seen: { BV1c: {} } })
  assert.deepEqual(viaCfg.map((item) => item.bvid), ['BV1a'])
})

test('rankCandidates：同分时 pubdate 新的在前', () => {
  const older = candidate({ bvid: 'BVgold', pubdate: 1000 })
  const newer = candidate({ bvid: 'BVnew', pubdate: 2000 })
  const ranked = rankCandidates([older, newer], { minDuration: 180, maxDuration: 1800 })
  assert.deepEqual(ranked.map((item) => item.bvid), ['BVnew', 'BVgold'])
})

test('verdictFor：阈值边界', () => {
  assert.equal(verdictFor(100), '值得看')
  assert.equal(verdictFor(75), '值得看')
  assert.equal(verdictFor(74), '可以看')
  assert.equal(verdictFor(50), '可以看')
  assert.equal(verdictFor(49), '不值当')
  assert.equal(verdictFor(0), '不值当')
  assert.equal(verdictFor(-1000), '不值当')
  assert.equal(verdictFor(Number.NaN), '不值当')
})

test('makePick / autoPick：字段完整、一句话不超 40 字', () => {
  const c = candidate({ title: '三分钟讲清楚一个原理' })
  const scored = { ...c, ...scoreCandidate(c, {}) }
  const pick = makePick(scored, { verdict: '值得看', oneLiner: '  标题挺实在，可以看看  ' })
  assert.equal(pick.verdict, '值得看')
  assert.equal(pick.oneLiner, '标题挺实在，可以看看')
  assert.ok(!Number.isNaN(new Date(pick.pickedAt).getTime()), 'pickedAt 应是 ISO 时间')

  const auto = autoPick(c, { minDuration: 180, maxDuration: 1800 })
  assert.ok(VERDICTS.includes(auto.verdict), `verdict 非法：${auto.verdict}`)
  assert.ok(charLength(auto.oneLiner) <= 40, `兜底一句话过长：${auto.oneLiner}`)
  assert.ok(auto.oneLiner.includes(c.owner), '一句话应带 UP 名')
  assert.ok(!auto.oneLiner.includes('\n'), '一句话不能有换行')

  // 显式传入非法 verdict 时按分数补
  const fallbackVerdict = makePick({ ...scored, score: 20 }, { oneLiner: '算了' })
  assert.equal(fallbackVerdict.verdict, '不值当')
})

test('formatDuration：常见时长格式', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(59), '0:59')
  assert.equal(formatDuration(754), '12:34')
  assert.equal(formatDuration(3723), '1:02:03')
})

// ---------------------------------------------------------------- report.mjs

test('renderCardwall：自包含、深色、转义用户数据', () => {
  const xss = makePick(
    candidate({
      bvid: 'BV1xss',
      title: '<script>alert("xss")</script>',
      duration: 900,
      cover: 'https://i0.hdslb.com/bfs/archive/xss.jpg',
    }),
    {
      verdict: '值得看',
      oneLiner: '他说 <b>必看</b> & 我不同意',
    },
  )
  const mid = makePick(candidate({ bvid: 'BV1mid' }), { verdict: '可以看', oneLiner: '有空可以看看' })
  const low = makePick(candidate({ bvid: 'BV1low', duration: 3600 }), { verdict: '不值当', oneLiner: '这次先跳过' })
  const html = renderCardwall([xss, mid, low], {
    title: '卡片墙测试 · <危险标题>',
    generatedAt: new Date(2026, 9, 22, 10, 30),
  })

  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), '标题里的 <script> 必须转义')
  assert.ok(!html.includes('<script'), 'HTML 里不应出现真实的 script 标签')
  assert.ok(!html.includes('<link'), '不应引用外部样式')
  assert.ok(html.includes('&lt;b&gt;必看&lt;/b&gt; &amp; 我不同意'), '一句话里的标签与 & 必须转义')
  assert.ok(html.includes('&lt;危险标题&gt;'), '标题参数也必须转义')

  assert.ok(html.includes('referrerpolicy="no-referrer"'), '封面必须带 no-referrer')
  assert.ok(html.includes('loading="lazy"'), '封面必须 lazy load')
  assert.ok(html.includes('class="card good"'))
  assert.ok(html.includes('class="badge good"'))
  assert.ok(html.includes('class="badge mid"'))
  assert.ok(html.includes('class="badge low"'))
  assert.ok(html.includes('15:00'), '应渲染格式化时长')
  assert.ok(html.includes('https://www.bilibili.com/video/BV1xss'), '应包含 BV 链接')
  assert.ok(html.includes('生成于 2026-10-22 10:30'), '顶部应有生成时间')
  assert.ok(html.includes('共 3 张卡片'), '顶部应有统计')
})

test('renderCardwall：封面协议地址规范化 + 空列表', () => {
  const pick = makePick(candidate({ cover: '//i0.hdslb.com/bfs/archive/cover.jpg' }), {
    verdict: '可以看',
    oneLiner: '看看封面',
  })
  const html = renderCardwall([pick])
  assert.ok(html.includes('src="https://i0.hdslb.com/bfs/archive/cover.jpg"'))

  const empty = renderCardwall([])
  assert.ok(empty.includes('这一轮没有投递的候选'))
  assert.ok(!empty.includes('<script'))
})

test('writeDigest：写临时目录、当天追加第二轮、不覆盖旧内容', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bili-lite-report-'))
  const day = '2099-12-31'
  const state = { seen: { BV1seen: { action: 'skipped' } }, picks: [] }
  const firstPick = makePick(candidate({ bvid: 'BV1first', title: '第一轮标题' }), {
    verdict: '值得看',
    oneLiner: '第一条的一句话',
    pickedAt: new Date(2099, 11, 31, 9, 5).toISOString(),
  })
  const secondPick = makePick(candidate({ bvid: 'BV1second', title: '<第二轮> 标题' }), {
    verdict: '不值当',
    oneLiner: '这次先跳过',
    pickedAt: new Date(2099, 11, 31, 15, 40).toISOString(),
  })

  try {
    const first = await writeDigest(state, {
      date: day,
      picks: [firstPick],
      scannedCount: 8,
      mode: 'demo',
      now: new Date(2026, 9, 22, 9, 5),
      baseDir: dir,
    })
    assert.equal(path.basename(first.mdPath), `${day}.md`)
    assert.equal(first.mdPath, path.join(dir, 'reports', `${day}.md`))
    assert.equal(first.htmlPath, path.join(dir, 'state', 'cardwall.html'))

    const md1 = await fsp.readFile(first.mdPath, 'utf8')
    assert.ok(md1.includes(`# bili-lite 日报 · ${day}`))
    assert.ok(md1.includes('## 09:05 第一轮'))
    assert.ok(md1.includes('第一轮标题'))
    assert.ok(md1.includes('值得看'))
    assert.ok(md1.includes('统计：本次扫描 8 条'))
    assert.ok(md1.includes('累计见过 1 条'))
    const html1 = await fsp.readFile(first.htmlPath, 'utf8')
    assert.ok(html1.includes('第一轮标题'))

    // 模拟 CLI 在第二轮前把第一轮结果写回 state.picks
    state.picks.push(firstPick)
    const second = await writeDigest(state, {
      date: day,
      picks: [secondPick],
      scannedCount: 5,
      mode: 'scan',
      now: new Date(2026, 9, 22, 15, 40),
      baseDir: dir,
    })
    const md2 = await fsp.readFile(second.mdPath, 'utf8')
    assert.ok(md2.startsWith(md1.trimEnd()), '第二轮必须在旧内容后追加，不能覆盖')
    assert.ok(md2.includes('## 15:40 第二轮'))
    assert.ok(md2.includes('第一轮标题') && md2.includes('第二轮'), '旧标题与新标题都应保留')
    assert.equal((md2.match(/^## \d{2}:\d{2} 第/gm) || []).length, 2, '应有两个轮次分段')
    assert.ok(md2.includes('统计：本次扫描 5 条'))

    // 卡片墙累积当天两轮的 pick
    const html2 = await fsp.readFile(second.htmlPath, 'utf8')
    assert.ok(html2.includes('第一轮标题') && html2.includes('&lt;第二轮&gt; 标题'))
    assert.ok(html2.includes('共 2 张卡片'))

    // 项目自己的 reports/ 不应被测试污染
    assert.equal(fs.existsSync(path.join(ROOT, 'reports', `${day}.md`)), false)
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('escapeHtml：基础字符转义', () => {
  assert.equal(escapeHtml('<a & "b" \'c\'>'), '&lt;a &amp; &quot;b&quot; &#39;c&#39;&gt;')
  assert.equal(escapeHtml(null), '')
})

// ---------------------------------------------------------------- persona.mjs

test('loadPersona：无配置时返回默认人设', () => {
  const missing = path.join(os.tmpdir(), `bili-lite-not-exist-${Date.now()}.md`)
  assert.deepEqual(loadPersona({}), { text: DEFAULT_PERSONA, source: 'default' })
  assert.deepEqual(loadPersona({ personaPath: missing }), { text: DEFAULT_PERSONA, source: 'default' })
  assert.deepEqual(loadPersona({ personaPath: missing, personaText: '   ' }), {
    text: DEFAULT_PERSONA,
    source: 'default',
  })

  const inline = loadPersona({ personaText: '冷淡、惜字如金' })
  assert.equal(inline.text, '冷淡、惜字如金')
  assert.equal(inline.source, 'config')
})

test('loadPersona：优先读 AGENTS.md 文件', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bili-lite-persona-'))
  const file = path.join(dir, 'AGENTS.md')
  try {
    await fsp.writeFile(file, '\n  直接、不客套，只讲结论。\n', 'utf8')
    const loaded = loadPersona({ personaPath: file, personaText: '内联不应生效' })
    assert.equal(loaded.text, '直接、不客套，只讲结论。')
    assert.equal(loaded.source, file)

    // 传目录时按约定找里面的 AGENTS.md
    const viaDir = loadPersona({ personaPath: dir })
    assert.equal(viaDir.text, '直接、不客套，只讲结论。')
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
})

test('buildOneLinerPrompt：包含全部 bvid 与严格 JSON 约束', () => {
  const list = [
    candidate({
      bvid: 'BV1AAA111',
      title: '教程：从零搭一个东西',
      desc: '一段简介 <含标签> & 符号',
      tags: ['编程', '教程'],
      comments: [
        { user: '甲', text: '讲得清楚', like: 10 },
        { user: '乙', text: '有点水', like: 3 },
        { user: '丙', text: '收藏了', like: 2 },
        { user: '丁', text: '第四条不该出现', like: 1 },
      ],
    }),
    candidate({ bvid: 'BV1BBB222', title: '实测三款工具' }),
    candidate({ bvid: 'BV1CCC333', title: '纪录片：某事始末' }),
  ]
  const prompt = buildOneLinerPrompt(list, { text: '直接、不吹捧' })

  for (const item of list) {
    assert.ok(prompt.includes(item.bvid), `提示词缺少 ${item.bvid}`)
  }
  assert.ok(prompt.includes('直接、不吹捧'), '应带上人设')
  assert.ok(prompt.includes('JSON 数组'), '应要求 JSON 数组')
  assert.ok(prompt.includes('值得看|可以看|不值当'), '应给出 verdict 枚举')
  assert.ok(prompt.includes('40'), '应限制 oneLiner 长度')
  assert.ok(prompt.includes('不能编造'), '应禁止编造内容')
  assert.ok(prompt.includes('热评'), '应包含热评摘要')
  assert.ok(prompt.includes('第四条不该出现') === false, '热评最多 3 条')
  assert.ok(prompt.includes('教程'), '应包含标题/标签')

  const empty = buildOneLinerPrompt([], '人设')
  assert.ok(empty.includes('共 0 条'))
})

test('buildReplyPrompt：带私信、视频摘要与 80 字限制', () => {
  const video = candidate({ title: '被分享的视频', owner: '分享者', duration: 754 })
  const prompt = buildReplyPrompt('这个视频值不值得看？', video, '直接、不吹捧')
  assert.ok(prompt.includes('这个视频值不值得看？'), '应包含原消息')
  assert.ok(prompt.includes('被分享的视频'), '应包含视频标题')
  assert.ok(prompt.includes('12:34'), '应包含视频时长')
  assert.ok(prompt.includes('80'), '应限制 80 字')
  assert.ok(prompt.includes('直接、不吹捧'), '应带上人设')
  assert.ok(prompt.includes('不吹捧'), '应要求不吹捧')

  const noVideo = buildReplyPrompt('在吗', null, '直接')
  assert.ok(noVideo.includes('（对方没有分享视频）'))
})
