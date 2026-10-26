// test/enrich.test.mjs — enrich.mjs 离线单测：所有网络调用都用 mock，不访问真实网络
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  danmakuHeat,
  downloadCover,
  enrichVideo,
  fetchSubtitleText,
  getDanmaku,
  getSubtitles,
  parseDanmakuXml,
  summarizeHeat,
  toPlainText,
} from '../src/enrich.mjs'
import { CookieJar } from '../src/http.mjs'

const DANMAKU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<i>
  <chatserver>chat.bilibili.com</chatserver>
  <d p="10.5,1,25,16777215,1700000000,0,abc,1">前排 &amp; 打卡</d>
  <d p="12,1,25,255,1700000001,0,abc,2"><![CDATA[<笑> 这也能 ?]]></d>
  <d p="14,5,25,16777215,1700000002,0,abc,3">&#39;引号&#39; &lt;3 &quot;ok&quot;</d>
  <d p="bad,1,25">坏时间</d>
  <d p="20,1,25,16777215,1700000003,0,abc,5"></d>
</i>`

test('parseDanmakuXml 解析 p 属性 / CDATA / 实体，并过滤坏行', () => {
  const items = parseDanmakuXml(DANMAKU_XML)
  assert.equal(items.length, 3)
  assert.deepEqual(items[0], { t: 10.5, text: '前排 & 打卡' })
  assert.deepEqual(items[1], { t: 12, text: '<笑> 这也能 ?' })
  assert.deepEqual(items[2], { t: 14, text: `'引号' <3 "ok"` })
})

test('getDanmaku 通过注入的 fetchText 拉取弹幕，失败返回 error 不抛错', async () => {
  const jar = new CookieJar()
  let requested = ''
  const ok = await getDanmaku(jar, {
    cid: 987,
    fetchText: async (url) => {
      requested = url
      return DANMAKU_XML
    },
  })
  assert.equal(requested, 'https://comment.bilibili.com/987.xml')
  assert.equal(ok.count, 3)
  assert.equal(ok.items.length, 3)

  const bad = await getDanmaku(jar, {
    cid: 987,
    fetchText: async () => {
      throw new Error('HTTP 500')
    },
  })
  assert.equal(bad.count, 0)
  assert.deepEqual(bad.items, [])
  assert.match(bad.error, /HTTP 500/)
})

test('danmakuHeat 按时间分桶、统计 top，并给出前 3 个 hotspots', () => {
  const items = [
    { t: 0, text: 'a' },
    { t: 1, text: 'a' },
    { t: 2, text: 'b' },
    { t: 31, text: 'c' },
    { t: 32, text: 'c' },
    { t: 33, text: 'c' },
    { t: 34, text: 'd' },
    { t: 95, text: 'e' },
  ]
  const heat = danmakuHeat({ items }, { duration: 120, buckets: 4 })
  assert.equal(heat.buckets.length, 4)
  assert.deepEqual(
    heat.buckets.map((bucket) => bucket.count),
    [3, 4, 0, 1],
  )
  assert.deepEqual(
    heat.buckets.map((bucket) => [bucket.from, bucket.to]),
    [
      [0, 30],
      [30, 60],
      [60, 90],
      [90, 120],
    ],
  )
  assert.deepEqual(heat.buckets[0].top, ['a', 'b'])
  assert.deepEqual(heat.buckets[1].top, ['c', 'd'])
  assert.deepEqual(heat.buckets[2].top, [])
  assert.deepEqual(heat.hotspots, [
    { from: 30, to: 60, count: 4 },
    { from: 0, to: 30, count: 3 },
    { from: 90, to: 120, count: 1 },
  ])
})

test('summarizeHeat 生成中文热区摘要，空数据显示兜底文案', () => {
  const heat = danmakuHeat(
    {
      items: [
        { t: 190, text: '这个梗' },
        { t: 191, text: '这个梗' },
        { t: 192, text: '哈哈' },
      ],
    },
    { duration: 600, buckets: 12 },
  )
  const summary = summarizeHeat(heat)
  assert.match(summary, /^弹幕集中在 02:30–03:20，讨论最多的是『这个梗』/)
  assert.match(summarizeHeat({ buckets: [], hotspots: [] }), /暂未发现明显弹幕热区/)
})

test('fetchSubtitleText 补全 // 协议并解析字幕行', async () => {
  let asked = ''
  const lines = await fetchSubtitleText(
    new CookieJar(),
    '//aisubtitle.hdslb.com/bfs/subtitle/abc.json',
    {
      fetchJson: async (url) => {
        asked = url
        return {
          body: [
            { from: 0, to: 2.5, content: '第一句' },
            { from: 2.5, to: 5, content: '第二句' },
            { from: 5, to: 6, content: '   ' },
          ],
        }
      },
    },
  )
  assert.equal(asked, 'https://aisubtitle.hdslb.com/bfs/subtitle/abc.json')
  assert.deepEqual(lines, [
    { from: 0, to: 2.5, text: '第一句' },
    { from: 2.5, to: 5, text: '第二句' },
  ])
  assert.equal(toPlainText(lines), '第一句第二句')
})

test('toPlainText 限制长度、为英文补空格、忽略空行', () => {
  assert.equal(toPlainText([{ text: 'Hello.' }, { text: 'World' }]), 'Hello. World')
  assert.equal(toPlainText([{ text: '' }, { text: '只有中文' }]), '只有中文')
  const long = toPlainText([{ text: '字'.repeat(4000) }], { maxChars: 3000 })
  assert.equal(long.length, 3000)
  assert.ok(long.endsWith('…'))
  assert.equal(toPlainText([{ text: '字'.repeat(20) }], 10).length, 10)
})

test('getSubtitles 匿名空列表判定 loginRequired（mock 返回）', async () => {
  let seenUrl = ''
  let seenReferer = ''
  let keysAsked = 0
  const result = await getSubtitles(
    new CookieJar(),
    { bvid: 'BV1xx411c7mD', cid: 123 },
    {
      // 连 WBI 取 key 也注入，保证这个用例完全离线
      getWbiKeys: async () => {
        keysAsked += 1
        return { imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32), mixin: 'c'.repeat(32) }
      },
      fetchJson: async (url, opts) => {
        seenUrl = url
        seenReferer = opts.referer
        return {
          code: 0,
          data: { login_mid: 0, subtitle: { lan: '', lan_doc: '', subtitles: [] } },
        }
      },
    },
  )
  assert.equal(keysAsked, 1)
  assert.match(seenUrl, /^https:\/\/api\.bilibili\.com\/x\/player\/wbi\/v2\?/)
  assert.match(seenUrl, /bvid=BV1xx411c7mD/)
  assert.match(seenUrl, /cid=123/)
  assert.match(seenUrl, /w_rid=[0-9a-f]{32}/)
  assert.equal(seenReferer, 'https://www.bilibili.com/video/BV1xx411c7mD')
  assert.equal(result.available, false)
  assert.equal(result.loginRequired, true)
  assert.deepEqual(result.subtitles, [])
  assert.match(result.hint, /登录/)
})

test('getSubtitles 登录态区分「无字幕」与「有字幕」', async () => {
  const jar = new CookieJar()
  const noSub = await getSubtitles(
    jar,
    { bvid: 'BV1xx411c7mD', cid: 1 },
    {
      mixin: 'm'.repeat(32),
      fetchJson: async () => ({
        code: 0,
        data: { login_mid: 12345, subtitle: { subtitles: [] } },
      }),
    },
  )
  assert.equal(noSub.available, false)
  assert.equal(noSub.loginRequired, false)
  assert.match(noSub.hint, /没有可用字幕/)

  const withSub = await getSubtitles(
    jar,
    { bvid: 'BV1xx411c7mD', cid: 1 },
    {
      mixin: 'm'.repeat(32),
      fetchJson: async () => ({
        code: 0,
        data: {
          login_mid: 0,
          subtitle: {
            subtitles: [
              {
                lan: 'zh-CN',
                lan_doc: '中文（中国）',
                subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/s.json',
                ai_type: 1,
              },
            ],
          },
        },
      }),
    },
  )
  assert.equal(withSub.available, true)
  assert.equal(withSub.loginRequired, false)
  assert.deepEqual(withSub.subtitles, [
    {
      lan: 'zh-CN',
      lanDoc: '中文（中国）',
      url: 'https://aisubtitle.hdslb.com/bfs/subtitle/s.json',
      aiType: 1,
    },
  ])
})

test('getSubtitles 接口 -101 / 网络失败都结构化降级', async () => {
  const jar = new CookieJar()
  const denied = await getSubtitles(
    jar,
    { bvid: 'BV1xx411c7mD', cid: 1 },
    {
      mixin: 'm'.repeat(32),
      fetchJson: async () => ({ code: -101, message: '账号未登录' }),
    },
  )
  assert.equal(denied.available, false)
  assert.equal(denied.loginRequired, true)
  assert.equal(denied.code, -101)
  assert.match(denied.hint, /账号未登录/)

  const offline = await getSubtitles(
    jar,
    { bvid: 'BV1xx411c7mD', cid: 1 },
    {
      mixin: 'm'.repeat(32),
      fetchJson: async () => {
        throw new Error('offline')
      },
    },
  )
  assert.equal(offline.available, false)
  assert.match(offline.hint, /offline/)
})

test('downloadCover 写入临时目录，失败返回 error', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-enrich-'))
  try {
    const ok = await downloadCover(new CookieJar(), {
      bvid: 'BV1xx411c7mD',
      pic: 'http://i0.hdslb.com/bfs/archive/a.jpg',
      dir,
      fetchBytes: async (url) => {
        assert.equal(url, 'https://i0.hdslb.com/bfs/archive/a.jpg')
        return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])
      },
    })
    assert.equal(ok.bytes, 8)
    assert.equal(ok.path, path.join(dir, 'BV1xx411c7mD.jpg'))
    assert.equal((await fs.readFile(ok.path)).length, 8)

    const failed = await downloadCover(new CookieJar(), {
      bvid: 'BV1xx411c7mD',
      pic: 'https://i0.hdslb.com/bfs/archive/a.jpg',
      dir,
      fetchBytes: async () => {
        throw new Error('HTTP 403')
      },
    })
    assert.match(failed.error, /HTTP 403/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('enrichVideo 成功路径把 summary / text 挂到 candidate 顶层', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-enrich-ok-'))
  try {
    const candidate = {
      bvid: 'BV1xx411c7mD',
      cid: 123,
      duration: 120,
      title: '测试视频',
      cover: 'https://i0.hdslb.com/bfs/archive/a.jpg',
    }
    const result = await enrichVideo(new CookieJar(), candidate, {
      mixin: 'm'.repeat(32),
      coverDir: dir,
      fetchJson: async () => ({
        code: 0,
        data: { login_mid: 0, subtitle: { subtitles: [] } },
      }),
      fetchText: async () =>
        '<i><d p="10,1,25">哈哈</d><d p="11,1,25">哈哈</d><d p="90,1,25">结束</d></i>',
      fetchBytes: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9]),
    })

    assert.equal(result.enrich.danmakuHeat.total, 3)
    assert.equal(result.danmakuHeat.total, 3)
    assert.match(result.danmakuHeat.summary, /弹幕集中在 00:10–00:20，讨论最多的是『哈哈』/)
    assert.equal(result.subtitles.available, false)
    assert.equal(result.subtitles.loginRequired, true)
    assert.equal(result.coverPath, path.join(dir, 'BV1xx411c7mD.jpg'))
    assert.deepEqual(result.enrichWarnings, ['字幕需要登录：匿名请求返回空字幕列表'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('enrichVideo 单个子项失败降级，不影响成功子项', async () => {
  const candidate = {
    bvid: 'BV1xx411c7mD',
    cid: 123,
    duration: 120,
    title: '测试视频',
    cover: 'http://i0.hdslb.com/bfs/archive/a.jpg',
  }
  const fetchJson = async (url) => {
    if (url.includes('/x/player/wbi/v2')) {
      return {
        code: 0,
        data: {
          login_mid: 0,
          subtitle: {
            subtitles: [
              {
                lan: 'zh-CN',
                lan_doc: '中文（中国）',
                subtitle_url: '//aisubtitle.hdslb.com/bfs/subtitle/s.json',
                ai_type: 0,
              },
            ],
          },
        },
      }
    }
    if (url.includes('/bfs/subtitle/s.json')) {
      return {
        body: [
          { from: 0, to: 1, content: '第一句' },
          { from: 1, to: 2, content: '第二句' },
        ],
      }
    }
    throw new Error(`unexpected url: ${url}`)
  }

  const result = await enrichVideo(new CookieJar(), candidate, {
    mixin: 'm'.repeat(32),
    fetchJson,
    fetchText: async () => {
      throw new Error('弹幕接口 500')
    },
    fetchBytes: async () => {
      throw new Error('封面 403')
    },
  })

  assert.equal(result, candidate)
  assert.equal(result.enrich.subtitles.available, true)
  assert.equal(result.enrich.subtitles.text, '第一句第二句')
  assert.equal(result.subtitles.text, '第一句第二句')
  assert.equal(result.enrich.danmakuHeat, null)
  assert.equal(result.danmakuHeat, null)
  assert.equal(result.enrich.coverPath, null)
  assert.equal(result.coverPath, null)
  assert.equal(result.enrichWarnings.length, 2)
  assert.ok(result.enrichWarnings.some((warning) => warning.includes('弹幕获取失败')))
  assert.ok(result.enrichWarnings.some((warning) => warning.includes('封面下载失败')))
})

test('enrichVideo 默认跳过已有的 enrich 子项', async () => {
  const candidate = {
    bvid: 'BV1xx411c7mD',
    cid: 1,
    duration: 10,
    cover: 'http://i0.hdslb.com/bfs/archive/a.jpg',
    enrich: {
      subtitles: { available: false, loginRequired: true, subtitles: [], text: '' },
      danmakuHeat: { buckets: [], hotspots: [], summary: '旧摘要' },
      coverPath: 'state/covers/BV1xx411c7mD.jpg',
    },
  }
  let calls = 0
  const result = await enrichVideo(new CookieJar(), candidate, {
    fetchJson: async () => {
      calls += 1
      throw new Error('不应调用 fetchJson')
    },
    fetchText: async () => {
      calls += 1
      throw new Error('不应调用 fetchText')
    },
    fetchBytes: async () => {
      calls += 1
      throw new Error('不应调用 fetchBytes')
    },
  })
  assert.equal(calls, 0)
  assert.equal(result.enrich.coverPath, 'state/covers/BV1xx411c7mD.jpg')
  assert.equal(result.enrich.danmakuHeat.summary, '旧摘要')
  assert.deepEqual(result.enrichWarnings, [])
})
