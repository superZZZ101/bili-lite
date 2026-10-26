// src/daemon-boot.mjs — 先补环境变量再加载 daemon.mjs
// 原因：state.mjs 在 import 时读取 BILI_LITE_HOME；计划任务里环境变量可能不可靠，
// 用这个入口保证 HOME 一定指向工作区的 .bili-lite（密钥也在那里的 secrets.json）。
process.env.BILI_LITE_HOME =
  process.env.BILI_LITE_HOME || 'C:\\Users\\user\\Documents\\ds_harness\\.bili-lite'

await import('./daemon.mjs')
