// test/auth-dm.test.mjs — auth.mjs / dm.mjs 纯函数单测（不访问网络）
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSendForm,
  clampDmText,
  extractBvid,
  filterInboxMessages,
  parseSessions,
  parseMessages,
} from '../src/dm.mjs'
import {
  buildCookieState,
  buildQrMatrix,
  checkLogin,
  cookiesToJar,
  parseCookieUrl,
  parseQrPoll,
  parseSetCookies,
  renderQrTerminal,
} from '../src/auth.mjs'
import { defaultConfig, defaultState, loadState } from '../src/state.mjs'

test('state: 默认配置与默认状态符合 SPEC', () => {
  const config = defaultConfig()
  assert.equal(config.dryRun, true)
  assert.equal(config.dailyLimit, 2)
  assert.equal(config.targetUid, 0)
  assert.equal(typeof config.minDuration, 'number')
  assert.equal(typeof config.maxDuration, 'number')

  const state = defaultState()
  assert.equal(state.version, 1)
  assert.equal(state.cookies, null)
  assert.deepEqual(state.seen, {})
  assert.deepEqual(state.candidates, [])
  assert.deepEqual(state.picks, [])

  const loaded = loadState()
  assert.equal(loaded.version, 1)
  assert.ok(Array.isArray(loaded.picks))
  assert.equal(typeof loaded.config.dryRun, 'boolean')
})

test('buildSendForm: 字段完整且 content 是 JSON 字符串', () => {
  const form = buildSendForm({
    senderUid: 42,
    receiverUid: 7,
    text: '你好，世界',
    csrf: 'csrf-token',
    devId: 'buvid-3-value',
    timestamp: 1700000000000,
  })
  assert.equal(form['msg[sender_uid]'], '42')
  assert.equal(form['msg[receiver_id]'], '7')
  assert.equal(form['msg[receiver_type]'], '1')
  assert.equal(form['msg[msg_type]'], '1')
  assert.deepEqual(JSON.parse(form['msg[content]']), { content: '你好，世界' })
  assert.equal(form.csrf, 'csrf-token')
  assert.equal(form.csrf_token, 'csrf-token')
  assert.equal(form['msg[dev_id]'], 'buvid-3-value')
  assert.equal(form['msg[timestamp]'], '1700000000000')
})

test('buildSendForm: 可选字段 dev_id/timestamp 缺省时不出现', () => {
  const form = buildSendForm({ senderUid: 1, receiverUid: 2, text: 'x', csrf: 'c', timestamp: 0 })
  assert.equal('msg[dev_id]' in form, false)
  assert.equal('msg[timestamp]' in form, false)
})

test('clampDmText: 500 字以内不截断，超出截到 480 + …', () => {
  const exact = clampDmText('a'.repeat(500))
  assert.equal(exact.truncated, false)
  assert.equal(exact.text.length, 500)

  const over = clampDmText('a'.repeat(501))
  assert.equal(over.truncated, true)
  assert.equal(over.text, `${'a'.repeat(480)}…`)
  assert.equal(Array.from(over.text).length, 481)

  const emoji = clampDmText('😀'.repeat(501))
  assert.equal(emoji.truncated, true)
  assert.equal(Array.from(emoji.text).length, 481)
  assert.ok(emoji.text.endsWith('…'))
})

test('extractBvid: 识别 BV 号，短链返回 null', () => {
  assert.equal(extractBvid('看这个 BV1GJ411x7h7 很不错'), 'BV1GJ411x7h7')
  assert.equal(extractBvid('https://www.bilibili.com/video/BV1xx411c7mD?p=1'), 'BV1xx411c7mD')
  assert.equal(extractBvid('https://b23.tv/abcd123'), null)
  assert.equal(extractBvid('没有 BV 号'), null)
  assert.equal(extractBvid(''), null)
  assert.equal(extractBvid(null), null)
})

test('parseSessions: 解析 talker_id/用户名/最后消息/未读数', () => {
  const resp = {
    code: 0,
    data: {
      session_list: [
        {
          talker_id: 123,
          unread_count: 2,
          account_info: { name: '小明' },
          last_msg: {
            msg_type: 1,
            content: JSON.stringify({ content: '晚上好' }),
            timestamp: 1700000000,
          },
        },
        {
          talker_id: 456,
          uname: '阿婆主',
          unread_count: 0,
          last_msg: {
            msg_type: 7,
            content: JSON.stringify({
              content: { title: '视频标题', jump_url: 'https://www.bilibili.com/video/BV1xx411c7mD' },
            }),
            timestamp: 1700000100,
          },
        },
      ],
    },
  }
  assert.deepEqual(parseSessions(resp), [
    { talkerId: 123, uname: '小明', lastMsg: '晚上好', ts: 1700000000, unread: 2 },
    { talkerId: 456, uname: '阿婆主', lastMsg: '视频标题', ts: 1700000100, unread: 0 },
  ])
  assert.deepEqual(parseSessions({ code: 0, data: {} }), [])
})

test('parseMessages: kind 归一为 text/share/other，保留 msgType，按时间升序', () => {
  const resp = {
    code: 0,
    data: {
      messages: [
        { sender_uid: 123, msg_type: 1, content: JSON.stringify({ content: '早' }), timestamp: 1700000002, msg_key: 'k2' },
        {
          sender_uid: 123,
          msg_type: 7,
          content: JSON.stringify({
            content: { title: '分享', jump_url: 'https://www.bilibili.com/video/BV1GJ411x7h7?x=1' },
          }),
          timestamp: 1700000003,
          msg_key: 'k3',
        },
        { sender_uid: 999, msg_type: 2, content: '{"url":"https://x/y.png"}', timestamp: 1700000001, msg_key: 'k1' },
      ],
    },
  }
  const messages = parseMessages(resp)
  assert.deepEqual(messages.map((m) => m.ts), [1700000001, 1700000002, 1700000003])
  assert.equal(messages[0].kind, 'image')
  assert.equal(messages[0].msgType, 2)
  assert.equal(messages[0].imageUrl, 'https://x/y.png')
  assert.equal(messages[1].kind, 'text')
  assert.equal(messages[1].msgType, 1)
  assert.equal(messages[1].text, '早')
  assert.equal(messages[1].senderUid, 123)
  assert.equal(messages[1].msgKey, 'k2')
  assert.equal(messages[2].kind, 'share')
  assert.equal(messages[2].msgType, 7)
  assert.equal(messages[2].shareBvid, 'BV1GJ411x7h7')
  assert.equal(messages[2].text, '分享')
})

test('parseMessages: 分享卡片支持嵌套 JSON，抽不到 BV 时保留 raw 片段', () => {
  const nested = parseMessages({
    code: 0,
    data: {
      messages: [
        {
          sender_uid: 1,
          msg_type: 7,
          timestamp: 2,
          content: JSON.stringify({
            content: JSON.stringify({
              title: '嵌套分享',
              jump_url: 'https://www.bilibili.com/video/BV1xx411c7mD',
            }),
          }),
        },
      ],
    },
  })
  assert.equal(nested[0].kind, 'share')
  assert.equal(nested[0].shareBvid, 'BV1xx411c7mD')
  assert.equal(nested[0].text, '嵌套分享')

  const noBvid = parseMessages({
    code: 0,
    data: {
      messages: [
        {
          sender_uid: 1,
          msg_type: 7,
          timestamp: 3,
          content: JSON.stringify({ content: { url: 'https://example.com/no-bv' } }),
        },
      ],
    },
  })
  assert.equal(noBvid[0].kind, 'share')
  assert.equal('shareBvid' in noBvid[0], false)
  assert.match(noBvid[0].text, /example\.com/)
})

test('parseMessages: content 不是 JSON 时退回原文', () => {
  const messages = parseMessages({
    code: 0,
    data: { messages: [{ sender_uid: 1, msg_type: 1, content: '纯文本', timestamp: 1 }] },
  })
  assert.equal(messages[0].text, '纯文本')
})

test('filterInboxMessages: 放行 owner 的 text 与 share，其它计数', () => {
  const result = filterInboxMessages(
    [
      { senderUid: 42, ts: 10, kind: 'text', text: '文字' },
      { senderUid: 42, ts: 11, kind: 'share', text: '', shareBvid: 'BV1GJ411x7h7' },
      { senderUid: 42, ts: 12, kind: 'other', text: '图片' },
      { senderUid: 9, ts: 13, kind: 'text', text: '别人发的' },
      { senderUid: 42, ts: 9, kind: 'text', text: '旧消息' },
    ],
    { sinceTs: 9, ownerUid: 42 },
  )
  assert.deepEqual(result.fromOwner.map((m) => m.ts), [10, 11])
  assert.equal(result.fromOwner[0].kind, 'text')
  assert.equal(result.fromOwner[1].kind, 'share')
  assert.equal(result.fromOwner[1].shareBvid, 'BV1GJ411x7h7')
  assert.equal(result.othersCount, 2)
})

test('parseQrPoll: 业务码在 data.code，覆盖 4 种状态', () => {
  assert.equal(parseQrPoll({ code: 0, data: { code: 86101 } }).status, 'waiting')
  assert.equal(parseQrPoll({ code: 0, data: { code: 86090 } }).status, 'scanned')
  assert.equal(parseQrPoll({ code: 0, data: { code: 86038 } }).status, 'expired')

  const ok = parseQrPoll({
    code: 0,
    data: { code: 0, url: 'https://passport.biligame.com/crossDomain?SESSDATA=a%2Cb&bili_jct=j' },
  })
  assert.equal(ok.status, 'success')
  assert.match(ok.url, /SESSDATA=/)

  // 顶层 code 非 0 → error，不误判为成功
  assert.equal(parseQrPoll({ code: -400, message: '请求错误' }).status, 'error')
  // 未知业务码 → unknown，继续轮询
  assert.equal(parseQrPoll({ code: 0, data: { code: 1 } }).status, 'unknown')
})

test('parseSetCookies: 只取 name=value，忽略 Expires 等属性', () => {
  const cookies = parseSetCookies([
    'SESSDATA=abc%2Cdef; Path=/; Domain=.bilibili.com; Expires=Wed, 09 Jun 2027 10:18:14 GMT',
    'bili_jct=xyz; Path=/',
    'DedeUserID=42; Path=/',
    'DedeUserID__ckMd5=md5; Path=/',
    'sid=s1; Path=/',
    'deleted_cookie=deleted; Path=/',
  ])
  assert.deepEqual(cookies, {
    SESSDATA: 'abc%2Cdef',
    bili_jct: 'xyz',
    DedeUserID: '42',
    DedeUserID__ckMd5: 'md5',
    sid: 's1',
  })
})

test('parseCookieUrl + buildCookieState: SESSDATA 保留 %2C，raw 全量保存', () => {
  const fromUrl = parseCookieUrl(
    'https://passport.biligame.com/crossDomain?DedeUserID=42&DedeUserID__ckMd5=md5&SESSDATA=abc%2Cdef&bili_jct=xyz&gourl=https%3A%2F%2Fwww.bilibili.com',
  )
  assert.equal(fromUrl.SESSDATA, 'abc%2Cdef')
  assert.equal(fromUrl.gourl, undefined)
  assert.equal(fromUrl.Expires, undefined)

  const cookies = buildCookieState({ ...fromUrl, buvid3: 'b3', buvid4: 'b4' })
  assert.equal(cookies.sessdata, 'abc%2Cdef')
  assert.equal(cookies.biliJct, 'xyz')
  assert.equal(cookies.dedeUserId, 42)
  assert.equal(cookies.buvid3, 'b3')
  assert.equal(cookies.buvid4, 'b4')
  assert.equal(cookies.raw.DedeUserID__ckMd5, 'md5')
  assert.ok(!Number.isNaN(Date.parse(cookies.savedAt)))
})

test('cookiesToJar: state 字段与 raw 都能还原成 Cookie 头', () => {
  const jar = cookiesToJar({
    sessdata: 'S',
    biliJct: 'J',
    dedeUserId: 42,
    raw: { DedeUserID__ckMd5: 'M', sid: 'SID' },
  })
  assert.equal(jar.get('SESSDATA'), 'S')
  assert.equal(jar.get('bili_jct'), 'J')
  assert.equal(jar.get('DedeUserID'), '42')
  assert.equal(jar.get('DedeUserID__ckMd5'), 'M')
  assert.equal(jar.get('sid'), 'SID')
})

test('checkLogin: 无 SESSDATA 时直接返回未登录（不发请求）', async () => {
  const result = await checkLogin({})
  assert.equal(result.isLogin, false)
  assert.match(result.reason, /SESSDATA/)
})

test('buildQrMatrix + renderQrTerminal: 矩阵可生成、终端行宽正确', () => {
  const matrix = buildQrMatrix('https://www.bilibili.com/')
  assert.ok(matrix.length >= 21)
  for (const row of matrix) assert.equal(row.length, matrix.length)
  assert.ok(matrix.some((row) => row.some(Boolean)))

  const lines = []
  renderQrTerminal(
    [
      [true, false],
      [false, true],
    ],
    { quiet: 1, out: (line) => lines.push(line) },
  )
  assert.equal(lines.length, 4)
  assert.equal(lines[0], '        ') // 2 个模块 + 左右 quiet 1，每格 2 字符
  assert.equal(lines[1], '  ██    ')
  assert.equal(lines[2], '    ██  ')
  assert.equal(lines[3], '        ')
})
