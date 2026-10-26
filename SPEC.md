# bili-lite 内部接口契约（摘要）

> Node.js ≥ 20，零第三方 npm 依赖；二维码依赖本地 `vendor/qrcode.js`。
> 所有业务命令最后一行输出 `RESULT_JSON: {...}`。

## 1. 状态与存储

`BILI_LITE_HOME`（默认 `.bili-lite`）：

```
state/state.json         登录态、配置、候选、今日计数
state/candidates.json    最近一次 scan 的候选
state/speech.jsonl       说过的每一句话（JSONL，上限 5000）
state/comments.md        评论台账（只读；评论发送已停用）
state/impressions.json   印象
state/mood.json          心情（五轴 + 底色）
state/life.json          生活计划、计数、小时去重
state/memory-*           每月遗忘的归档/总结/元数据
state/frames/<bvid>/<run>/  抽帧结果（默认保留 1 天）
diary/public.md          公开日记
diary/private.md         私密日记
reports/YYYY-MM-DD.md    本地报告
```

`state.json` 关键字段：

```ts
{
  cookies: null | { sessdata, biliJct, dedeUserId, buvid3, buvid4, raw, savedAt },
  config: {
    targetUid, dailyLimit, dryRun, personaText, personaPath,
    replyStrangers, watchInterval, sessionResetRounds, sessionResetChars,
    lifeEnabled, lifeScanLimit, dynamicDailyCap, proactiveDailyCap,
    memoryKeepRatio
  },
  candidates: Candidate[],
  picks: Pick[],
  sentToday: number,
  lastScanAt: string | null
}
```

## 2. 候选与选片

`Candidate`（scan 产出）：

```ts
{
  bvid, aid, cid, title, owner, ownerMid, duration, pubdate, desc,
  tags: string[], stat: { view, like, danmaku, reply, favorite, coin, share },
  cover, url, comments?: Comment[], danmaku?: string[], score?: number
}
```

`Pick`：

```ts
{ bvid, verdict: '值得看'|'可以看'|'不值当', oneLiner, review?, at }
```

## 3. 命令

| 命令 | 作用 |
| --- | --- |
| `status` | 登录态、配置、计数、生活概览 |
| `login [--force]` | 扫码登录，cookie 只写本地 |
| `scan --limit N` | 推荐流 + 详情/热评/弹幕/封面 |
| `review` | 生成选片提示词，写 `state/prompt-oneliner.md` |
| `pick --bvid ... --verdict ... --one-liner ... [--review ...]` | 记录选择 |
| `send [--yes] [--force] [--text ...] [--file ...]` | 发送私信/生成报告 |
| `inbox [--since N]` | 读主人新私信 |
| `reply --text ... [--to uid]` | 回复私信 |
| `frames --bvid ... [--sparse] [--fps] [--max-sheets] [--no-vision]` | 抽帧 |
| `frames --vision-only/--vision-status` | 本地识图/读进度 |
| `diary`, `mood`, `impressions`, `speech`, `memory` | 日记/心情/印象/发言/遗忘 |
| `life ...` | 生活循环、动作、主动分享 |
| `dynamic post/check/delete` | 动态 |
| `comments list/stats/file` | 评论台账（只读） |
| `config key=value` | 修改配置 |

## 4. B 站接口

- 推荐流：`/x/web-interface/wbi/index/top/feed/rcmd`（WBI 签名）
- 视频详情：`/x/web-interface/view?bvid=`
- 热评：`/x/v2/reply`
- 弹幕：`https://comment.bilibili.com/<cid>.xml`
- 私信发送：`/x/msgfeed/send`（需要 `bili_jct` csrf）
- 私信列表：`/x/msgfeed/recent` / `/x/msgfeed/detail`
- 动态：`/x/dynamic/feed/create/dyn`
- 投币：`/x/web-interface/coin/add`
- 收藏：`/x/v3/fav/resource/deal`
- 关注：`/x/relation/modify`

所有请求带 `User-Agent`、`Referer: https://www.bilibili.com/`、cookie jar；遇到 `-352/-412/-509` 停止并退避。

## 5. DSH 插件

`plugin/bili-lite-watch`：

- `sessionController.create({sessionId})` / `prompt(...)` 注入回合
- `workspaceController.archiveSession({sessionId})` 归档旧会话
- 轮询私信、生活定时唤醒、每日会话、`BILI_LITE_KEEP_DAYS` 归档
- `plugin/bili-model-route`：只把 `bili-lite*` 会话路由到指定 provider/model，其它放行

## 6. 限制

- 私信单条 500 字符；发送层按 460 字拆条。
- 动态 3/天；投币 5/天；追番 1/月；主动私信 10/天；评论停用。
- 心情单次每轴 ≤0.15，一小时 ≤0.25，一天 ≤0.5。
- 抽帧默认 1.2 帧/秒，3×3 联络表；张数默认不限；图片默认保留 1 天。

## 7. 错误约定

- `RESULT_JSON.ok=false` 时带 `error`；退出码非 0。
- 风控错误原样报告，不重试；不绕过验证码。
