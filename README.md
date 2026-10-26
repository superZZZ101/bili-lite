# bili-lite

一个轻量的 B 站推荐流助手：扫描推荐、筛出少数值得看的视频、生成一句话/点评，并把结果发到 B 站私信或落到本地报告。另带一个可选的「她自己的生活」循环：定时刷几条、记印象、写两本日记、偶尔发动态。

> 仅用于个人学习和自动化实验。B 站接口有风控，**请使用小号、低频运行**；不要提交 cookie、API key 或任何账号凭据。

## 功能

- `scan`：刷推荐流，补视频详情/热评/弹幕/封面
- `review` / `pick`：按信息密度、新鲜度、偏好、时间成本挑 1~3 条
- `send`：按 460 字拆条发私信（默认 dry-run；收件人必须是另一个账号）
- `inbox` / `reply`：处理主人私信；可选 DSH 宿主插件常驻监听
- `life`：低谷期每两小时做一件小事（刷视频、记印象、写日记、发动态、点赞/收藏等）
- `frames`：用 ffmpeg 抽帧，默认 **1.2 帧/秒（约 0.83 秒一格）**，每 9 帧拼 3×3 联络表；张数默认不限
- 两本日记、心情、印象、发言记录、每月遗忘
- 评论功能默认停用（只看不评）；动态 3/天；投币 5/天

## 要求

- Node.js ≥ 20（零第三方 npm 依赖）
- Python 3 + Pillow：抽帧拼图
- ffmpeg：密集抽帧（没有则退回 B 站 videoshot，密度较低）
- Ollama + `qwen3-vl:8b`：可选的本地识图对照
- DSH（可选）：宿主插件、会话注入、工具调用

## 快速开始

```powershell
git clone <this-repo> bili-lite
cd bili-lite
npm test

# 运行数据放工作区，避免写进仓库
$env:BILI_LITE_HOME = (Join-Path (Get-Location) '.bili-lite')

node src/cli.mjs status
node src/cli.mjs login          # 手机 B 站扫码，按提示确认
node src/cli.mjs scan --limit 8
node src/cli.mjs review
# 按 review 的提示挑条目：
node src/cli.mjs pick --bvid BV... --verdict 值得看 --one-liner "一句话"
node src/cli.mjs send           # dry-run 预览
node src/cli.mjs config dryRun=false
node src/cli.mjs send --yes
```

没有第二个 B 站账号时，`send` 会因「不能给自己发私信」失败；用 `demo` 或 `scan` 生成本地报告即可。

## 配置

`config.example.json` 是默认配置；运行时会写到 `$BILI_LITE_HOME/state/state.json`。常用项：

| 键 | 说明 |
| --- | --- |
| `targetUid` | 私信收件人（另一个账号，且与登录号互关） |
| `dailyLimit` | 每日发送上限 |
| `dryRun` | 只预览不发送 |
| `personaText` | 偏好描述，用于筛选/点评 |
| `lifeEnabled` | 生活循环开关 |
| `lifeScanLimit` | 每轮最多刷几条 |
| `dynamicDailyCap` | 动态/天（3） |
| `proactiveDailyCap` | 主动私信/天（10） |

环境变量：`BILI_LITE_HOME`、`BILI_LITE_SESSION`、`BILI_LITE_KEEP_DAYS`、`BILI_FRAME_KEEP_DAYS`、`BILI_DENSE_FPS`、`BILI_VISION`、`BILI_VISION_MODEL`、`OLLAMA_URL`。

## 抽帧

```powershell
node src/cli.mjs frames --bvid BV... --no-vision   # 只抽帧，约 16 秒
node src/cli.mjs frames --vision-only --bvid BV... # 可选：本地 Qwen 识图，2 张/次
node src/cli.mjs frames --vision-status --bvid BV...
```

默认 1.2 帧/秒、3×3 联络表、张数不限；`--max-sheets N` 可全片均匀封顶，`--fps 0.63` 回旧密度，`--sparse` 才抽 1~12 张单图。

## DSH 插件（可选）

`plugin/bili-lite-watch` 是一个宿主插件：轮询私信、按天注入会话、生活定时唤醒、归档旧会话。它依赖 DSH 的 `sessionController`/`workspaceController`，不装 DSH 时只用 CLI 也能跑。

## 目录

```
src/       CLI 与业务逻辑
plugin/    DSH 宿主插件
prompts/   人设、日记、点评提示词
test/      node:test 单测
vendor/    二维码等前端依赖
```

## 安全与边界

- 不要提交 `state/`、`diary/`、`reports/`、cookie、API key；`.gitignore` 已忽略这些。
- 只给另一个账号发私信；B 站不允许给自己发私信。
- 自动化可能违反平台条款；频率过高会触发 `-352`/`-412`/`-509`。
- 评论默认停用；动态/私信发出前请自行检查内容。
- 本项目不提供任何账号、cookie 或 token。

## License

MIT
