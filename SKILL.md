---
name: bili-lite
description: 刷 B 站推荐流，挑出值得看的 1~3 条，把标题、链接和一句话通过 B 站私信发到另一个账号（B 站不允许给自己发私信），或落到本地报告；可选的生活循环、抽帧、两本日记与记忆。
whenToUse: 用户让你刷 B 站推荐、筛选视频、发私信汇报，或让这个小助手自己刷视频/写日记/记录印象时。
---

# bili-lite

B 站推荐流助手。所有业务命令最后一行都是 `RESULT_JSON: {...}`，先解析这一行再决定下一步。

## 运行前提

- Node.js ≥ 20；抽帧另需 Python 3 + Pillow，密集抽帧需 ffmpeg。
- 安装目录：把本仓库放到 DSH skill 目录，例如 `%USERPROFILE%\.dsh\skills\bili-lite`；或直接在本仓库运行 `node src/cli.mjs`。
- 运行数据放 `BILI_LITE_HOME`（默认 `.bili-lite`），不要写进仓库。
- 首次使用 `login` 让用户自己扫码；不要索要账号密码、短信验证码或 cookie。

## 工作流

### 1. 登录与状态

```powershell
node src/cli.mjs status
node src/cli.mjs login
```

- 未登录才 `login`；二维码/提示原样转告用户，不替用户确认。
- `status` 看 `loggedIn`、`config.targetUid`、`config.dryRun`、`counts`。

### 2. 扫描与筛选

```powershell
node src/cli.mjs scan --limit 8
node src/cli.mjs review
```

- `review` 会把提示词写到 `state/prompt-oneliner.md`；读 `state/candidates.json` 后按四个维度挑：
  信息密度、新鲜度、与用户偏好的相关度、时间成本。
- 每条给 `值得看` / `可以看` / `不值当` 和一句 ≤40 字的话；不编造视频内容。

### 3. 记录与发送

```powershell
node src/cli.mjs pick --bvid BV... --verdict 值得看 --one-liner "……"
node src/cli.mjs send            # dry-run
node src/cli.mjs config dryRun=false
node src/cli.mjs send --yes
```

- 私信只发给 `targetUid`（另一个账号，且与登录号互关）；给自己会报 `21026`，不要绕过。
- 失败最多重试 2 次；风控 `-352` / `-412` / `-509` 时停止本轮。

### 4. 私信

```powershell
node src/cli.mjs inbox
node src/cli.mjs reply --text "……"
```

- 只回主人；陌生人按 `replyStrangers` 策略处理。
- 回复风格以 `prompts/review.md` 为准；不知道就说不知道，不编。

### 5. 抽帧（看视频）

```powershell
node src/cli.mjs frames --bvid BV... --no-vision   # 默认 1.2 帧/秒，3×3 联络表，张数不限
node src/cli.mjs frames --vision-only --bvid BV... # 可选：本地 Qwen 识图
node src/cli.mjs frames --vision-status --bvid BV...
```

- 默认约 0.83 秒一格；`--max-sheets N` 可封顶，`--sparse` 才抽单图。
- DeepSeek 会话能看图时可直接 `read_image`；本地 Qwen 只是对照。
- 评论功能默认停用：只看不评、不回复评论。

### 6. 生活循环（可选）

```powershell
node src/cli.mjs life status
node src/cli.mjs life context
node src/cli.mjs life tick
node src/cli.mjs life action like|fav|coin|follow|unfollow|bangumi ...
node src/cli.mjs life action dynamic --text "……" [--bvid BV...]
node src/cli.mjs diary add --text "……" [--private] [--bvid BV...]
node src/cli.mjs mood adjust --warmth +0.1 --talk -0.05 --why "……"
node src/cli.mjs impressions add --title "……" --content "……" --why "……"
```

- 生活提示词包含人设、心情、日记路径、技术计数；由 DSH 插件定时注入。
- 评论停用；动态 3/天、投币 5/天、追番 1/月；主动私信 10/天。
- 不向主人汇报行程；日记是记忆，不是台词。

### 7. 记忆

```powershell
node src/cli.mjs memory status
node src/cli.mjs memory consolidate --month 2026-10 --summary "……" --keep "id1,id2"
```

- 每月保留约 63%，最近 7 天和 pinned 保护；忘掉的进 `state/memory-archive/`。

## 硬性规则

- 不把 cookie / SESSDATA / bili_jct / API key 打印、写入报告或发到聊天。
- 不编造视频内容；材料不足就说不足。
- 不代替用户登录；不索要密码/验证码。
- 评论默认停用；不要发评论或回复评论。
- 动态/私信是公开痕迹，内容先给用户确认；不带个人隐私。
- 频率宁低勿高；失败两次就停，不密集重试。

## 输出解析

每条业务命令最后一行：

```text
RESULT_JSON: {"ok":true,...}
```

解析失败时结合 stderr 和退出码判断；`ok:false` 不要当成功。
