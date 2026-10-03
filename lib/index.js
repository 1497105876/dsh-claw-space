// lib/index.js — @gw/dsh-claw-space host 半（Node 端，跑在 dsh 主进程）。
//
// 编排：
//   1. 解析 workspace 目录（config.dir → $DSH_HOME/openclaw → ~/.dsh/openclaw）
//   2. 创建 workspace 管理器（文件族注入 + 人设操作）与 inject 管理器（自由块）
//   3. fs.watch 盯整个 openclaw 目录（recursive，Windows 原子保存已兼容），150ms 防抖
//      → 两个管理器统一 registerAll（内容不变时官方投影自动去重，不重复注入）
//   4. webServer 同源路由 /claw-space/*（设置页面板数据通道，M3）
//   5. /user 斜杠命令：会话级人设绑定（多魂，M5；commands 服务缺失时软降级）
//   6. ctx.effect 完整清理（function 声明的 apply 会被 new 调用，返回值丢弃——
//      不能只靠 return dispose，这是 cordis 的坑）

import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createRequire } from "node:module"
import { createWorkspaceManager } from "./workspace.js"
import { createInjectManager, release } from "./inject.js"
import { registerRoutes } from "./routes.js"
import { registerSoulCommand } from "./soulcmd.js"

export const name = "@gw/dsh-claw-space"

/** 硬依赖（cordis 红线：访问 ctx.xxx 必须先 inject）。 */
export const inject = ["systemPrompt", "webServer"]

// ── 配置 schema（schemastery，拿不到则跳过校验不影响加载）──
let Config
try {
  const req = createRequire(import.meta.url)
  const loaded = req("@deepseek-ai/schemastery")
  const z = (loaded && loaded.default) || loaded
  if (z && typeof z.object === "function") {
    Config = z.object({
      dir: z.string().default(""),
      dailyNoteLimit: z.number().default(2),
      inject: z.boolean().default(true),
      panelEnabled: z.boolean().default(true),
      perFileLimits: z.any(),
    })
  }
} catch (e) {
  Config = undefined
}
export { Config }

const DEFAULT_DAILY_LIMIT = 2

function resolveWorkspaceDir(config) {
  if (config && config.dir && String(config.dir).trim()) return path.resolve(String(config.dir).trim())
  const base = process.env.DSH_HOME || path.join(os.homedir(), ".dsh")
  return path.join(base, "openclaw")
}

export function apply(ctx, config = {}) {
  const log = (...a) => { try { ctx.logger?.info?.(...a) } catch (e) {} }
  const warn = (...a) => { try { ctx.logger?.warn?.(...a) } catch (e) {} }

  const dir = resolveWorkspaceDir(config)
  const sp = ctx.systemPrompt
  const dailyNoteLimit = Number.isFinite(config.dailyNoteLimit) && config.dailyNoteLimit >= 0
    ? Math.floor(config.dailyNoteLimit)
    : DEFAULT_DAILY_LIMIT

  log(`[claw-space] 加载中，workspace 目录: ${dir}`)

  // ── 两个管理器 ────────────────────────────────────────────
  const workspace = createWorkspaceManager({
    dir,
    sp,
    log,
    warn,
    dailyNoteLimit,
    perFileLimits: config.perFileLimits,
  })
  const injectMgr = createInjectManager({
    file: path.join(dir, "inject.md"),
    sp,
    log,
    warn,
  })

  // ── 热加载：fs.watch 盯目录（Windows 原子保存 = 临时文件替换，盯目录才稳）──
  let watcher = null
  let reloadTimer = null
  let disposed = false

  function reloadAll(reason) {
    if (disposed) return
    try {
      workspace.refreshCache()
      workspace.registerAll()
      injectMgr.load()
      injectMgr.registerAll()
      log(`[claw-space] 已热加载（${reason || "手动"}）`)
    } catch (e) {
      if (disposed) return // 卸载竞态：定时器可能在插件已卸载后才触发，静默吞掉
      warn(`[claw-space] 热加载失败: ${e?.message}`)
    }
  }

  const onFsEvent = () => {
    if (disposed) return
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => reloadAll("文件变化"), 150)
  }
  try {
    watcher = fs.watch(dir, { recursive: true }, onFsEvent)
  } catch (e) {
    warn(`[claw-space] 目录监听失败（热加载不可用，注入功能不受影响）: ${e?.message}`)
  }

  // ── 清理：ctx.effect 登记（幂等），不靠 return dispose ────
  // /user 命令（多魂）：commands 服务动态取，缺了软降级（不进静态 inject，
  // 避免个别 profile 缺服务时整插件加载失败）
  let commandsSvc = null
  try { commandsSvc = ctx.get ? ctx.get("commands") : null } catch (e) { commandsSvc = null }
  let soulDisposer = null
  try {
    soulDisposer = registerSoulCommand({ commands: commandsSvc, workspace, log, warn })
  } catch (e) {
    warn(`[claw-space] /user 命令注册异常: ${e?.message}`)
  }

  let routeDisposer = null
  try {
    routeDisposer = registerRoutes({ webServer: ctx.webServer, ctx, workspace, injectMgr, sp, log, warn })
  } catch (e) {
    warn(`[claw-space] 路由注册异常: ${e?.message}`)
  }

  function dispose() {
    disposed = true
    clearTimeout(reloadTimer)
    workspace.dispose()
    injectMgr.dispose()
    release(soulDisposer)
    release(routeDisposer)
    release(watcher)
  }
  if (typeof ctx.effect === "function") {
    ctx.effect(() => dispose, "@gw/dsh-claw-space")
  }

  log(`[claw-space] 已加载：workspace ${dir}；设置页数据端点 /claw-space/state`)
  return dispose
}
