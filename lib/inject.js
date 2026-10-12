// lib/inject.js — 自由注入块（[system]/[context]）管理。
//
// 职责：inject.md 解析（parser.js）、官方 section/context 通道注册、
//       块级启停与排序、MIN_ORDER 约束、disposer 三形态归一、卸载竞态容错。

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseBlocks, serializeBlocks, DEFAULT_SYSTEM_ORDER, DEFAULT_CONTEXT_ORDER } from "./parser.js"

export { DEFAULT_SYSTEM_ORDER, DEFAULT_CONTEXT_ORDER }

/** 系统提示词侧允许的最小 order（0 = 官方 deployment:persona 段位置，不许再往前插）。 */
export const MIN_ORDER = 0

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SEED_FILE = path.resolve(HERE, "..", "seed", "inject.md")

/** disposer 三形态归一（函数 / .dispose() / .close()），卸载竞态容错。 */
export function release(d) {
  if (!d) return
  try {
    if (typeof d === "function") d()
    else if (typeof d.dispose === "function") d.dispose()
    else if (typeof d.close === "function") d.close()
  } catch (e) { /* 释放失败不影响其它清理 */ }
}

export function releaseAll(list) {
  const items = list.splice(0).reverse()
  for (const d of items) release(d)
}

/** 保存前校验（供路由层与内部 reload 共用）。 */
export function validateBlocks(blocks) {
  const errs = []
  if (!Array.isArray(blocks)) return ["数据格式不对：blocks 必须是数组"]
  const seen = new Set()
  blocks.forEach((b, i) => {
    const at = `第 ${i + 1} 个块`
    if (!b || typeof b !== "object") return errs.push(`${at}：不是对象`)
    if (b.type !== "system" && b.type !== "context") return errs.push(`${at}：类型必须是 system 或 context`)
    const title = String(b.title || "").trim()
    if (!title) errs.push(`${at}：标题不能为空`)
    const key = `${b.type}:${title}`
    if (title) {
      if (seen.has(key)) errs.push(`「${title}」在同类下重复了，段名会撞车导致注册失败`)
      seen.add(key)
    }
    if (b.order !== undefined && b.order !== null && b.order !== "" && !Number.isFinite(Number(b.order))) {
      errs.push(`${at}：排序必须是数字`)
    }
    if (b.enabled === undefined) b.enabled = true
  })
  return errs
}

/**
 * 创建自由注入块管理器。
 * @param opts `{ file, sp, log, warn, sectionPrefix? }`
 * @returns `{ registerAll, load, replaceBlocks, snapshot, dispose }`
 */
export function createInjectManager({ file, sp, log, warn, sectionPrefix = "gw-inject:" }) {
  let state = { raw: "", blocks: [] }
  let sysDisposers = []
  let ctxDisposers = []
  let registerErrors = []
  let disposed = false

  const readRaw = () => { try { return fs.readFileSync(file, "utf8") } catch (e) { return "" } }

  function ensureFile() {
    try {
      if (!fs.existsSync(file)) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        let seed = ""
        try { seed = fs.readFileSync(SEED_FILE, "utf8") } catch (e) {}
        if (!seed) seed = "# 文字注入配置\n\n## [system] 示例\n在这里写要常驻注入的内容。\n"
        fs.writeFileSync(file, seed, "utf8")
      }
    } catch (e) {
      warn(`[claw-space] 初始化 inject.md 失败: ${e?.message}`)
    }
  }

  function load() {
    const raw = readRaw()
    state = { raw, blocks: parseBlocks(raw) }
    return state
  }

  /** 按官方规则注册所有块。先全部撤掉旧的，再注册新的（顺序不能反，否则撞名）。 */
  function registerAll() {
    releaseAll(sysDisposers)
    releaseAll(ctxDisposers)
    registerErrors = []
    if (disposed) return

    if (!sp || typeof sp.section !== "function" || typeof sp.context !== "function") {
      registerErrors.push("systemPrompt 服务不可用，注入未生效")
      return
    }

    let nSys = 0
    let nCtx = 0
    for (const b of state.blocks) {
      if (!b.enabled) continue
      if (!b.body || !b.body.trim()) continue

      const title = (b.title || "").trim()
      if (!title) {
        registerErrors.push(`有一个 ${b.type === "system" ? "系统提示词" : "上下文"}块没有标题，已被跳过`)
        continue
      }

      const order = Number.isFinite(b.order) ? b.order : (b.type === "system" ? DEFAULT_SYSTEM_ORDER : DEFAULT_CONTEXT_ORDER)
      // 系统侧落在官方固定段之前的，按 MIN_ORDER 抬高（只抬高，不阻断）
      const effective = b.type === "system" ? Math.max(order, MIN_ORDER) : order

      try {
        if (b.type === "system") {
          // interpolate: false——块正文是用户手写内容，含 {{xxx}} 时不能走官方变量插值
          //（未注册变量会 throw，炸掉整个 assemble）
          sysDisposers.push(sp.section({ name: sectionPrefix + title, order: effective, interpolate: false, text: b.body }))
          nSys++
        } else {
          ctxDisposers.push(sp.context({ name: sectionPrefix + title, order: effective, interpolate: false, text: b.body }))
          nCtx++
        }
      } catch (e) {
        registerErrors.push(`「${title}」注册失败：${e?.message || e}`)
      }
    }

    if (nSys || nCtx) log(`[claw-space] 已注册 ${nSys} 个系统提示词块、${nCtx} 个上下文块`)
    for (const err of registerErrors) warn(`[claw-space] ${err}`)
  }

  function replaceBlocks(blocks) {
    const errs = validateBlocks(blocks)
    if (errs.length) return errs
    fs.writeFileSync(file, serializeBlocks(blocks), "utf8")
    load()
    registerAll()
    return []
  }

  function snapshot() {
    return {
      file,
      raw: state.raw,
      blocks: state.blocks,
      errors: [...registerErrors],
      minOrder: MIN_ORDER,
      defaults: { system: DEFAULT_SYSTEM_ORDER, context: DEFAULT_CONTEXT_ORDER },
    }
  }

  function dispose() {
    disposed = true
    releaseAll(sysDisposers)
    releaseAll(ctxDisposers)
  }

  ensureFile()
  load()
  registerAll()

  return { registerAll, load, replaceBlocks, snapshot, dispose }
}
