// lib/routes.js — webServer 同源路由 /claw-space/*（设置页面板数据通道）。
//
// webServer.register({kind:"prefix"})，同源
// fetch，无 CORS、不占额外端口。headless / 无 webServer 时整个路由不存在，
// 注入功能不受影响（软降级）。
//
// 接口：
//   GET  /state                → { workspace, files, inject } 面板全量快照
//   GET  /file?path=rel        → { path, raw } 读 workspace 内文件
//   POST /file/save            → { path, content } 原子写（.current 写保护）
//   POST /persona/switch       → { name }        切换人设
//   POST /injection/enabled    → { value }       注入总开关（关 = 本插件全部段不注入）
//   POST /persona/new          → { name, fromCurrent? }
//   POST /persona/delete       → { name }        （前端二次确认）
//   POST /binding/unbind       → { sessionId }   解绑一个会话
//   POST /binding/clear        →                 清空全部绑定
//   POST /inject/save          → { blocks }      保存自由块（校验 + 重注册）
//   POST /preview              → sp.assemble() 全量装配预览（全部段列出）

import fs from "node:fs"
import path from "node:path"

const ROUTE_PREFIX = "/claw-space"

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = ""
    req.on("data", (c) => {
      buf += c
      if (buf.length > 8e6) { try { req.destroy() } catch (e) {} }
    })
    req.on("end", () => resolve(buf))
    req.on("error", () => resolve(""))
  })
}

const parseJson = (s) => { try { return JSON.parse(s) } catch (e) { return null } }

/** 路径穿越防护：解析后必须仍在 workspace 目录内（Windows 大小写不敏感比较）。 */
function safeResolve(dir, rel) {
  const relNorm = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "")
  if (!relNorm) return null
  const dirAbs = path.resolve(dir)
  const abs = path.resolve(dirAbs, relNorm)
  const lowAbs = abs.toLowerCase()
  const lowDir = dirAbs.toLowerCase()
  if (lowAbs !== lowDir && !lowAbs.startsWith(lowDir + path.sep)) return null
  return abs
}

/** 本插件注册的段名前缀（预览里标「我的」）。 */
const MINE_PREFIXES = ["openclaw:", "gw-inject:"]

export function registerRoutes({ webServer, ctx, workspace, injectMgr, sp, log, warn }) {
  const dir = workspace.dir

  // 预览：全量视角（拍板 2026-10-03：全部段都列出，不再按来源白名单隐藏——
  // 面板是本机同源视图，看自己的装配没有拦截理由）。
  // section 段（identity/user/tools/agents）直接显示 assemble 真实文本（含来源标注，
  // 与实际注入一致）；context 段（memory/heartbeat/daily）因 mainOnly/门控在全局
  // 装配中可能为空，在**注入总开关开启时**用 segmentTextFor 显示文件原文作为补充
  // 视角——总开关关闭时如实显示空（否则会出现「关了还在预览里」的假象）。
  async function buildPreview(scope) {
    const context = scope ? { agent: scope, scope } : {}
    const asm = await sp.assemble(context)
    let allChars = 0
    let mineChars = 0
    const injectionOn = workspace.injectEnabled()
    const RAW_VIEW = new Set(["openclaw:memory", "openclaw:heartbeat", "openclaw:daily"])
    const shape = (list, kind) => (list || [])
      .map((s) => {
        const name = String(s.name ?? "")
        let text = String(s.text ?? "")
        if (injectionOn && RAW_VIEW.has(name)) {
          const raw = workspace.segmentTextFor(name)
          if (raw !== null && raw !== undefined) text = raw
        }
        allChars += text.length
        const mine = name.startsWith("openclaw:") || name.startsWith("gw-inject:")
        if (mine) mineChars += text.length
        return {
          name,
          chars: text.length,
          text,
          mine,
          empty: text.length === 0,
          kind,
        }
      })
    const sys = shape(asm.sections, "system")
    const cxs = shape(asm.contexts, "context")
    return {
      system: { sections: sys, totalChars: sys.reduce((a, s) => a + s.chars, 0) },
      context: { sections: cxs, totalChars: cxs.reduce((a, s) => a + s.chars, 0) },
      totals: { allChars, mineChars },
    }
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1")
      const p = url.pathname.slice(ROUTE_PREFIX.length) || "/"
      const q = url.searchParams

      // 读全量状态
      if (req.method === "GET" && (p === "/state" || p === "/")) {
        return json(res, 200, {
          workspace: workspace.snapshot(),
          files: workspace.listFiles(),
          inject: injectMgr.snapshot(),
        })
      }

      // 读文件（限 workspace 内）
      if (req.method === "GET" && p === "/file") {
        const rel = q.get("path") || ""
        const abs = safeResolve(dir, rel)
        if (!abs) return json(res, 400, { error: "路径不在 workspace 内" })
        try {
          const raw = fs.readFileSync(abs, "utf8")
          return json(res, 200, { path: rel, raw })
        } catch (e) {
          return json(res, 404, { error: "读不到这个文件" })
        }
      }

      const body = ["POST"].includes(req.method) ? parseJson(await readBody(req)) || {} : {}

      // 写文件（限 workspace 内；.current 由人设接口专用）
      if (req.method === "POST" && p === "/file/save") {
        const rel = String(body.path || "")
        const abs = safeResolve(dir, rel)
        if (!abs) return json(res, 400, { error: "路径不在 workspace 内" })
        if (rel.replace(/\\/g, "/") === ".current") return json(res, 400, { error: ".current 由人设操作管理，不能直接改" })
        if (typeof body.content !== "string") return json(res, 400, { error: "content 必须是字符串" })
        try {
          fs.writeFileSync(abs, body.content, "utf8")
        } catch (e) {
          return json(res, 500, { error: `写入失败：${e?.message}` })
        }
        return json(res, 200, { ok: true, workspace: workspace.snapshot() })
      }

      // 人设操作
      if (req.method === "POST" && p === "/persona/switch") {
        return json(res, 200, { ...workspace.switchPersona(String(body.name || "")), workspace: workspace.snapshot() })
      }
      // 清空指针：回到「未命名默认」（全局默认 = 根目录文件本身，与库存解绑）
      if (req.method === "POST" && p === "/persona/clear") {
        return json(res, 200, { ...workspace.clearCurrent(), workspace: workspace.snapshot() })
      }
      // 全局默认人设注入开关（拍板 2026-10-04）：关闭时未绑定会话不注入 IDENTITY/USER
      if (req.method === "POST" && p === "/injection/enabled") {
        return json(res, 200, { ...workspace.setInjectionEnabled(body.value !== false), workspace: workspace.snapshot() })
      }
      if (req.method === "POST" && p === "/persona/new") {
        return json(res, 200, { ...workspace.newPersona(String(body.name || ""), { fromCurrent: !!body.fromCurrent }), workspace: workspace.snapshot() })
      }
      if (req.method === "POST" && p === "/persona/delete") {
        return json(res, 200, { ...workspace.deletePersona(String(body.name || "")), workspace: workspace.snapshot() })
      }

      // 会话绑定操作（多魂，M5）：绑定/换绑只由会话里的 /user 命令产生（拍板
      // 2026-10-04：面板不提供切换入口），面板侧只做解绑/清空
      if (req.method === "POST" && p === "/binding/unbind") {
        return json(res, 200, { ...workspace.setBinding(String(body.sessionId || ""), null), workspace: workspace.snapshot() })
      }
      if (req.method === "POST" && p === "/binding/clear") {
        return json(res, 200, { ...workspace.clearBindings(), workspace: workspace.snapshot() })
      }

      // 自由块保存
      if (req.method === "POST" && p === "/inject/save") {
        const errs = injectMgr.replaceBlocks(body.blocks)
        if (errs.length) return json(res, 400, { error: errs[0], errors: errs })
        return json(res, 200, { ok: true, inject: injectMgr.snapshot() })
      }

      // 注入预览：只做全局装配（无 agent 作用域）——会话作用域预览整卡砍掉，
      // 「会话」从预览里彻底消失；全局装配（M1 探针实测）只含注册段，无对话投影。
      if (req.method === "POST" && p === "/preview") {
        const out = { ok: true, errors: [], scopes: [] }
        try {
          out.global = await buildPreview(undefined)
          out.scopes.push("global")
        } catch (e) {
          out.ok = false
          out.errors.push(`全局装配失败：${e?.message || e}`)
        }
        return json(res, 200, out)
      }

      return json(res, 404, { error: "未知接口" })
    } catch (e) {
      try { json(res, 500, { error: String(e?.message || e) }) } catch (e2) {}
    }
  }

  try {
    if (!webServer || typeof webServer.register !== "function") {
      warn("[claw-space] 未找到 ctx.webServer，设置页面板不可用（注入功能不受影响）")
      return null
    }
    const disposer = webServer.register({ kind: "prefix", path: ROUTE_PREFIX, handler })
    log(`[claw-space] 数据端点已注册：${ROUTE_PREFIX}/state`)
    return disposer
  } catch (e) {
    warn(`[claw-space] 注册数据端点失败: ${e?.message}`)
    return null
  }
}
