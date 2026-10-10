// lib/autowrite.js — 会话空闲自动记忆提炼（自动写入，不靠模型主动调工具）。
//
// 拍板（2026-10-10，方案 33-projectmemory）：
//   触发 = 会话空闲防抖（默认 60s，turn/end 重置计时器）
//   提炼 = 复用 dsh 子代理（ctx.agents 动态取，零新增 npm 依赖）
//   落盘 = ~/.dsh/openclaw/MEMORY.md + memory/<date>.md（只增不删，原子写）
//   与 AGENTS.md 协议写入并存（不移除提示词通道）；agent 自行决定 git commit 时机
//
// 机制：
//   1. ctx.on("session/event", {global:true}) 抓主会话 user/assistant 文本 → 环形缓冲
//   2. turn/end 重置防抖；到点且无提炼在跑 → 单飞提炼（运行中再触发 = re-arm）
//   3. 子代理读转写本 + 现有 MEMORY.md + 今日 daily，只回 JSON {"memory":[],"daily":[]}
//   4. 逐行精确去重后原子追加写盘；空结果不写
//
// 配置 = DEFAULTS + cordis Config.autoWrite + workspace/.autowrite.json（每次决策点
// fresh read，改动热生效）。落盘沿用 workspace 的 fs.watch（写入即触发热加载）。
//
// 软降级：agents / agentDefaultModel 服务拿不到 → warn 一次并整体停用，
// 不进静态 inject，避免个别 profile 缺服务时整插件加载失败。

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

// ────────────────────────────────────────────────────────────────
//  配置
// ────────────────────────────────────────────────────────────────

/** 面板与 cordis 配置共用的默认值。 */
export const AUTOWRITE_DEFAULTS = Object.freeze({
  enabled: true,
  idleMs: 60000,
  maxTranscriptChars: 24000,
  minTranscriptChars: 200,
  model: "",
  extractTimeoutMs: 120000,
})

/** 数值项的合法区间（校验与钳制共用）。 */
const RANGES = {
  idleMs: [1000, 3600000],
  maxTranscriptChars: [4000, 200000],
  minTranscriptChars: [0, 200000],
  extractTimeoutMs: [10000, 600000],
}

const CONFIG_FILE = ".autowrite.json"
const MEMORY_FILE = "MEMORY.md"
const MODEL_MAX = 200
const ITEM_MAX = 500
const MEMORY_ENTRY_MAX = 30
const DAILY_ENTRY_MAX = 50
const MEMORY_PROMPT_CLIP = 6000
const DAILY_PROMPT_CLIP = 4000
/** 连续失败到这个数就强制消费缓冲，避免坏转写永远重试。 */
const MAX_FAILS = 3

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** 严格校验一段 patch；返回错误文案或 null。 */
function validatePatch(patch) {
  if (!isPlainObject(patch)) return "patch 必须是对象"
  const allowed = new Set(Object.keys(AUTOWRITE_DEFAULTS))
  for (const k of Object.keys(patch)) if (!allowed.has(k)) return `未知配置项：${k}`
  if ("enabled" in patch && typeof patch.enabled !== "boolean") return "enabled 必须是布尔值"
  for (const key of Object.keys(RANGES)) {
    if (!(key in patch)) continue
    const v = patch[key]
    if (typeof v !== "number" || !Number.isInteger(v)) return `${key} 必须是整数`
    const [lo, hi] = RANGES[key]
    if (v < lo || v > hi) return `${key} 必须在 ${lo}..${hi} 之间`
  }
  if ("model" in patch) {
    if (typeof patch.model !== "string") return "model 必须是字符串"
    if (patch.model.length > MODEL_MAX) return `model 不能超过 ${MODEL_MAX} 字符`
  }
  return null
}

/** 宽松提取：把手改/旧版本的文件内容洗成合法子集（越界钳到边界）。 */
function normalize(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled
  if (typeof raw.model === "string") out.model = raw.model.slice(0, MODEL_MAX).trim()
  for (const key of Object.keys(RANGES)) {
    const v = Number(raw[key])
    if (Number.isInteger(v)) {
      const [lo, hi] = RANGES[key]
      out[key] = Math.min(hi, Math.max(lo, v))
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────
//  小工具
// ────────────────────────────────────────────────────────────────

function readText(absPath) {
  try { return fs.readFileSync(absPath, "utf8") } catch (e) { return null }
}

/** 原子写：临时文件 + rename，崩溃不留半截文件（与 workspace.js 同款）。 */
function writeFileAtomic(absPath, content) {
  const tmp = absPath + ".tmp-" + Date.now()
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(tmp, content, "utf8")
  fs.renameSync(tmp, absPath)
}

/** 截尾保新：超长只留最后一段（最近的内容对提炼更有用）。 */
function clipTail(text, max) {
  const s = String(text || "")
  if (s.length <= max) return s
  return "…（前文省略）\n" + s.slice(s.length - max)
}

/** 取消息内容里的纯文本块拼接。 */
function textOf(content) {
  if (!Array.isArray(content)) return ""
  let out = ""
  for (const block of content) {
    if (block && block.type === "text" && typeof block.text === "string") out += (out ? "\n" : "") + block.text
  }
  return out.trim()
}

/** 行规范化：去首尾空白 + 折叠空白 + 统一 `- ` 项目符号前缀。 */
function normLine(s) {
  const t = String(s || "").trim().replace(/\s+/g, " ")
  if (!t) return ""
  const m = /^[-*]\s+(.*)$/.exec(t)
  return m ? "- " + m[1].trim() : t
}

/** 提炼条目清洗：折叠空白 + 截到单条上限。 */
function cleanItem(s) {
  const t = String(s || "").trim().replace(/\s+/g, " ")
  return t.length > ITEM_MAX ? t.slice(0, ITEM_MAX) + "…" : t
}

function localDate(d) {
  const x = d || new Date()
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`
}

function localTime(d) {
  const x = d || new Date()
  return `${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`
}

/** 给一个 promise 加硬超时（防止子代理卡死把单飞锁永久占住）。 */
function withTimeout(p, ms, label) {
  let timer = null
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), Math.max(1, ms))
  })
  return Promise.race([p, guard]).finally(() => clearTimeout(timer))
}

// ────────────────────────────────────────────────────────────────
//  提炼 prompt / 结果解析
// ────────────────────────────────────────────────────────────────

function buildPrompt(transcript, memoryCtx, dailyCtx) {
  return [
    "你是记忆提炼器，只输出一个 JSON 对象：不要解释、不要寒暄、不要调用任何工具、不要写代码。",
    "",
    "把下面的「会话转写」精炼成可长期复用的记忆条目，输出格式严格为：",
    '{"memory": ["长期记忆条目"], "daily": ["今日流水条目"]}',
    "",
    "规则：",
    "- memory：跨天仍然成立的长期事实（用户偏好、约定、项目状态、重要结论、踩过的坑）。每条一行、自足可读、不超过 100 字，最多 30 条。",
    "- daily：只属于今天的流水（今天做了什么、当前进展、待办）。每条一行、不超过 100 字，最多 50 条。",
    "- 已经出现在「现有长期记忆」或「今日日志」里的内容不要再输出；没有信息量的寒暄与流水账不要硬凑。",
    "- 没有值得记录的内容时输出 {\"memory\":[],\"daily\":[]}。",
    "- 内容用简体中文；必须能被 JSON.parse 直接解析，可以包在 ```json 代码围栏里。",
    "",
    "现有长期记忆（MEMORY.md，勿重复）：",
    memoryCtx || "（空）",
    "",
    `今日日志（${localDate()}，勿重复）：`,
    dailyCtx || "（空）",
    "",
    "会话转写：",
    transcript,
  ].join("\n")
}

/** 从首个 `{` 到末个 `}` 截取并解析（容忍代码围栏与杂文字）。 */
function parseResult(text) {
  const s = String(text || "")
  const i = s.indexOf("{")
  const j = s.lastIndexOf("}")
  if (i < 0 || j <= i) throw new Error("子代理输出里没有 JSON 对象")
  let obj
  try {
    obj = JSON.parse(s.slice(i, j + 1))
  } catch (e) {
    throw new Error(`JSON 解析失败：${e?.message || e}`)
  }
  if (!isPlainObject(obj)) throw new Error("子代理输出不是 JSON 对象")
  const clean = (v, cap) => {
    if (!Array.isArray(v)) return []
    const out = []
    for (const raw of v) {
      const t = cleanItem(raw)
      if (t && out.length < cap && !out.includes(t)) out.push(t)
    }
    return out
  }
  return {
    memory: clean(obj.memory, MEMORY_ENTRY_MAX),
    daily: clean(obj.daily, DAILY_ENTRY_MAX),
  }
}

// ────────────────────────────────────────────────────────────────
//  落盘（只增不删）
// ────────────────────────────────────────────────────────────────

/** 追加长期记忆；返回实际新增条数。逐行精确去重，绝不改动既有行。 */
function appendToMemory(dir, items) {
  if (!items.length) return 0
  const abs = path.join(dir, MEMORY_FILE)
  const cur = readText(abs)
  if (cur === null) {
    // 缺件时按 seed 建档（与 workspace.js 的 seed 文案一致）
    const seed = "# MEMORY — 长期记忆\n\n> 全局共享（仅主会话注入，子代理不可见）。\n> 每条一行精炼事实；长了会被截断（完整内容 agent 可按注入标签的路径自行读取）。\n"
    return writeBatch(abs, seed, items)
  }
  return writeBatch(abs, cur, items)
}

/** 追加今日流水；返回实际新增条数。无则建 `# YYYY-MM-DD` 头，再挂 `## 自动记录 HH:mm` 小节。 */
function appendToDaily(dir, items) {
  if (!items.length) return 0
  const today = localDate()
  const abs = path.join(dir, "memory", `${today}.md`)
  const cur = readText(abs)
  const base = cur === null ? `# ${today}\n` : cur
  const head = `${base}${base.endsWith("\n") ? "" : "\n"}${base.trim() ? "\n" : ""}## 自动记录 ${localTime()}\n`
  return writeBatch(abs, head, items)
}

/**
 * 把条目逐行去重后接到 base 后面，原子写回。
 * 去重集合 = 文件全部行（规范化后），命中即跳过；只增不删。
 */
function writeBatch(abs, base, items) {
  const seen = new Set()
  for (const line of base.split("\n")) {
    const n = normLine(line)
    if (n) seen.add(n)
  }
  const adds = []
  for (const raw of items) {
    const item = cleanItem(raw)
    if (!item) continue
    const n = normLine("- " + item)
    if (!n || seen.has(n)) continue
    seen.add(n)
    adds.push(n)
  }
  if (!adds.length) return 0
  writeFileAtomic(abs, `${base}${base.endsWith("\n") ? "" : "\n"}${adds.join("\n")}\n`)
  return adds.length
}

// ────────────────────────────────────────────────────────────────
//  模块
// ────────────────────────────────────────────────────────────────

/**
 * 创建自动记忆模块。
 * @param opts `{ dir, ctx, log, warn, config }` — config = cordis Config.autoWrite（启动默认）
 * @returns `{ snapshot, setConfig, dispose }`
 */
export function createAutoWriter({ dir, ctx, log, warn, config }) {
  const abs = (...p) => path.join(dir, ...p)
  const startConfig = normalize(config)

  let disposed = false
  let running = false
  let rearm = false
  let degraded = null // 软降级原因（非 null = 已停用）
  let agentsCache
  let agentsProbed = false

  let lastRunAt = null
  let lastError = null
  let lastWritten = { memory: 0, daily: 0 }

  /** sid -> { chunks, chars, timer, fails, snapChunks } */
  const buffers = new Map()
  const disposers = []

  // ── 配置 ────────────────────────────────────────────────
  function readFileConfig() {
    return normalize(parseJsonFile(abs(CONFIG_FILE)))
  }

  function parseJsonFile(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch (e) { return null }
  }

  /** 有效配置：DEFAULTS + cordis 启动配置 + 工作区文件覆盖。每次决策点 fresh read。 */
  function effective() {
    const merged = { ...AUTOWRITE_DEFAULTS, ...startConfig, ...readFileConfig() }
    if (merged.minTranscriptChars > merged.maxTranscriptChars) merged.minTranscriptChars = merged.maxTranscriptChars
    return merged
  }

  /** 只把「与基线不同」的键写进文件：面板存一次也不会把 cordis 配置永久盖死。 */
  function setConfig(patch) {
    const err = validatePatch(patch)
    if (err) return { ok: false, error: err }
    const base = { ...AUTOWRITE_DEFAULTS, ...startConfig }
    const next = { ...effective(), ...normalize(patch) }
    if (next.minTranscriptChars > next.maxTranscriptChars) {
      return { ok: false, error: "minTranscriptChars 不能大于 maxTranscriptChars" }
    }
    const out = {}
    for (const k of Object.keys(AUTOWRITE_DEFAULTS)) if (next[k] !== base[k]) out[k] = next[k]
    try {
      writeFileAtomic(abs(CONFIG_FILE), JSON.stringify(out, null, 2) + "\n")
    } catch (e) {
      return { ok: false, error: `配置写入失败：${e?.message || e}` }
    }
    return { ok: true, config: next }
  }

  // ── 软降级：服务探测 ────────────────────────────────────
  function svc(name) {
    try { return ctx && typeof ctx.get === "function" ? ctx.get(name) : null } catch (e) { return null }
  }

  function agentsService() {
    if (agentsProbed) return agentsCache
    agentsProbed = true
    const a = svc("agents")
    agentsCache = a && typeof a.create === "function" ? a : null
    if (!agentsCache) {
      degraded = "agents 服务不可用"
      warn("[claw-space] 自动记忆停用：拿不到 agents 服务（子代理提炼不可用）")
      for (const b of buffers.values()) clearTimeout(b.timer)
      buffers.clear()
    }
    return agentsCache
  }

  /** 提炼用路由：默认模型选择 → 会话最近一次请求头 → 配置 model 覆盖。 */
  function resolveRoute(cfg, session) {
    let provider = ""
    let model = ""
    try {
      const sel = svc("agentDefaultModel")?.currentSelection?.()
      if (sel && sel.provider && sel.model) { provider = sel.provider; model = sel.model }
    } catch (e) {}
    if (!provider || !model) {
      try {
        const h = typeof session?.requestHeader === "function" ? session.requestHeader() : null
        const c = h && h.config
        if (c && c.provider && c.model) { provider = c.provider; model = c.model }
      } catch (e) {}
    }
    const m = String(cfg.model || "").trim()
    if (m) {
      const i = m.indexOf("/")
      if (i > 0 && i < m.length - 1) { provider = m.slice(0, i); model = m.slice(i + 1) }
      else model = m
    }
    if (!provider || !model) throw new Error("拿不到 provider/model（默认模型选择与会话请求头都为空）")
    return { provider, model }
  }

  // ── 事件缓冲 ────────────────────────────────────────────
  function push(session, sid, label, text, cfg) {
    if (!text || !cfg || !cfg.enabled || degraded) return
    let b = buffers.get(sid)
    if (!b) {
      b = { session, chunks: [], chars: 0, timer: null, idleAt: null, fails: 0, snapChunks: 0 }
      buffers.set(sid, b)
    }
    b.session = session
    b.idleAt = null // 新消息进来 = 还没空闲，等下一个 turn/end 再防抖
    const chunk = `${label}: ${text}`
    b.chunks.push(chunk)
    b.chars += chunk.length + 1
    // 环形：超上限丢最旧（快照期内丢弃要同步扣减 snapChunks）
    while (b.chars > cfg.maxTranscriptChars && b.chunks.length > 1) {
      const dropped = b.chunks.shift()
      b.chars -= dropped.length + 1
      if (b.snapChunks > 0) b.snapChunks--
    }
  }

  function arm(sid, cfg) {
    if (disposed) return
    if (!cfg || !cfg.enabled || degraded) return
    const b = buffers.get(sid)
    if (!b || !b.chunks.length) return
    clearTimeout(b.timer)
    b.timer = setTimeout(() => {
      b.timer = null
      b.idleAt = Date.now()
      if (disposed) return
      schedule()
    }, cfg.idleMs)
  }

  function isMainSession(session) {
    const h = session && session.header
    if (!h) return false // header 不可达：保守跳过，绝不误提子代理
    return !h.parentSession && (h.delegationDepth === undefined || h.delegationDepth === 0)
  }

  function onSessionEvent(session, event) {
    if (disposed || degraded || !event || !session) return
    try {
      if (!isMainSession(session)) return
      const cfg = effective()
      if (!cfg.enabled) return
      const sid = String(session.id || (session.header && session.header.id) || "")
      if (!sid) return
      if (event.type === "user/message") {
        const msg = event.data
        if (!msg || (msg.source && msg.source.kind === "runtime-context")) return
        push(session, sid, "用户", textOf(msg.content), cfg)
      } else if (event.type === "assistant/message") {
        const msg = event.data && event.data.message
        if (!msg) return
        push(session, sid, "AI", textOf(msg.content), cfg)
      } else if (event.type === "turn/end") {
        arm(sid, cfg)
      }
    } catch (e) {
      warn(`[claw-space] 自动记忆事件处理失败: ${e?.message || e}`)
    }
  }

  function onSessionDisposed(session) {
    if (!session) return
    const sid = String(session.id || (session.header && session.header.id) || "")
    const b = buffers.get(sid)
    if (!b) return
    clearTimeout(b.timer)
    buffers.delete(sid)
  }

  // ── 单飞调度 ────────────────────────────────────────────
  function schedule() {
    if (disposed) return
    if (running) { rearm = true; return }
    running = true
    Promise.resolve()
      .then(runExtract)
      .catch((e) => { lastError = e?.message || String(e); warn(`[claw-space] 自动记忆提炼失败: ${lastError}`) })
      .finally(() => {
        running = false
        if (rearm && !disposed) { rearm = false; schedule() }
      })
  }

  function consume(b) {
    const n = Math.max(0, b.snapChunks || 0)
    for (let i = 0; i < n; i++) b.chunks.shift()
    b.chars = b.chunks.reduce((a, c) => a + c.length + 1, 0)
    b.snapChunks = 0
  }

  function markDirty(sid, ok) {
    const b = buffers.get(sid)
    if (!b) return
    if (ok) { consume(b); b.fails = 0; return }
    b.fails++
    if (b.fails >= MAX_FAILS) {
      warn(`[claw-space] 会话 ${sid} 连续 ${b.fails} 次提炼失败，丢弃本轮转写继续监听`)
      consume(b)
      b.fails = 0
    }
  }

  // ── 提炼主流程 ──────────────────────────────────────────
  async function runExtract() {
    if (disposed) return
    const cfg = effective()
    if (!cfg.enabled || degraded) return
    const agents = agentsService()
    if (!agents) return

    const dirty = []
    for (const [sid, b] of buffers) {
      // 只取「已空闲（防抖到点）且还没等到下一轮」的会话
      if (!b.idleAt || b.timer || !b.chunks.length || b.chars < cfg.minTranscriptChars) continue
      dirty.push({ sid, b })
    }
    if (!dirty.length) return

    // 快照：提取期间新到的消息留在缓冲里，本轮只消费快照部分
    const snaps = dirty.map(({ sid, b }) => {
      b.snapChunks = b.chunks.length
      return { sid, text: clipTail(b.chunks.join("\n"), cfg.maxTranscriptChars) }
    })

    let transcript = snaps.map((s) => `【会话 ${s.sid}】\n${s.text}`).join("\n\n")
    transcript = clipTail(transcript, cfg.maxTranscriptChars)

    try {
      const memoryCtx = clipTail(readText(abs(MEMORY_FILE)) || "", MEMORY_PROMPT_CLIP)
      const dailyPath = abs("memory", `${localDate()}.md`)
      const dailyCtx = clipTail(readText(dailyPath) || "", DAILY_PROMPT_CLIP)

      const primary = dirty[0]
      const route = resolveRoute(cfg, primary.b.session)
      const prompt = buildPrompt(transcript, memoryCtx, dailyCtx)
      const raw = await runChild({
        agents, cfg, prompt, route,
        parentSid: primary.sid,
        cwd: parentCwd(primary.b.session),
      })
      const result = parseResult(raw)
      if (disposed) return // 插件已卸载：不再落盘

      const nMemory = appendToMemory(dir, result.memory)
      const nDaily = appendToDaily(dir, result.daily)

      for (const { sid } of dirty) markDirty(sid, true)
      lastRunAt = Date.now()
      lastError = null
      lastWritten = { memory: nMemory, daily: nDaily }
      log(`[claw-space] 自动记忆已写入：长期 +${nMemory}，今日 +${nDaily}`)
    } catch (e) {
      lastRunAt = Date.now()
      lastError = e?.message || String(e)
      for (const { sid } of dirty) {
        markDirty(sid, false)
        arm(sid, cfg) // 失败后重新防抖重试；缓冲被 MAX_FAILS 丢空时 arm 自然早退
      }
      warn(`[claw-space] 自动记忆提炼失败（缓冲保留待重试）: ${lastError}`)
    }
  }

  /** 主会话 cwd（子代理 meta 必须是绝对路径）；拿不到就回落到进程 cwd。 */
  function parentCwd(session) {
    const c = session && session.header && session.header.cwd
    return typeof c === "string" && path.isAbsolute(c) ? c : process.cwd()
  }

  /**
   * 起一个一次性子代理跑提炼：不组合 preset（无工具、无父会话提示段），
   * setup 里再显式 restrict 掉全部全局工具，双保险。
   * 创建 + 执行共用一条 extractTimeoutMs 死线，任何一环卡死都不会把单飞锁永久占住。
   */
  async function runChild({ agents, cfg, prompt, route, parentSid, cwd }) {
    const deadline = Date.now() + cfg.extractTimeoutMs
    const left = () => Math.max(1, deadline - Date.now())
    let handle = null
    let abandoned = false

    const creating = agents.create({
      sessionId: randomUUID(),
      meta: {
        cwd: cwd || process.cwd(),
        parentSession: parentSid,
        origin: "subagent",
        delegationDepth: 1,
        isSeeded: false,
      },
      agentOptions: { provider: route.provider, model: route.model, subagentDepth: 1 },
      setup: (childCtx) => {
        try {
          const tools = typeof childCtx.get === "function" ? childCtx.get("tools") : null
          if (tools && typeof tools.restrict === "function") tools.restrict({ allow: [] })
        } catch (e) {
          warn(`[claw-space] 自动记忆子代理工具限制失败（不影响提炼）: ${e?.message || e}`)
        }
      },
    }).then((h) => {
      // 已经放弃这一轮（超时/出错）才创建出来的句柄没人接管，直接收掉
      if (abandoned) { try { Promise.resolve(h.dispose()).catch(() => {}) } catch (e) {} }
      else handle = h
      return h
    })

    try {
      await withTimeout(creating, left(), "创建提炼子代理")
      const child = handle && handle.agent
      if (!child) throw new Error("子代理创建失败")

      const boundary = child.session.seq
      child.followup({
        id: randomUUID(),
        role: "user",
        content: [{ type: "text", text: prompt }],
        source: { kind: "user" },
      })
      await withTimeout(child.whenIdle(), left(), "提炼执行")

      return readChildOutput(child.session, boundary)
    } catch (e) {
      abandoned = true
      throw e
    } finally {
      abandoned = true
      if (handle) {
        try { await withTimeout(Promise.resolve(handle.dispose()), 5000, "子代理清理") }
        catch (e) { warn(`[claw-space] 自动记忆子代理清理失败: ${e?.message || e}`) }
      }
    }
  }

  /** 读子代理最后一轮：要求 turn/end 正常收尾，取最后一条 assistant 文本。 */
  function readChildOutput(session, boundary) {
    let events
    try { events = session.snapshotEvents(boundary) } catch (e) { events = session.snapshotEvents() }
    let endKind = null
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === "turn/end") {
        const r = events[i].data && events[i].data.reason
        endKind = typeof r === "string" ? r : (r && r.kind) || "unknown"
        break
      }
    }
    if (endKind !== null && endKind !== "completed") throw new Error(`提炼子代理未正常收尾（${endKind}）`)
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]
      if (e.type === "assistant/message" && e.data && e.data.message) {
        const text = textOf(e.data.message.content)
        if (text) return text
      }
    }
    throw new Error("提炼子代理没有产出文本")
  }

  // ── 对外 ────────────────────────────────────────────────
  function snapshot() {
    let sessions = 0
    let chars = 0
    for (const b of buffers.values()) {
      if (!b.chunks.length) continue
      sessions++
      chars += b.chars
    }
    return {
      config: effective(),
      running,
      degraded,
      buffered: { sessions, chars },
      lastRunAt,
      lastError,
      lastWritten: { ...lastWritten },
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    for (const b of buffers.values()) clearTimeout(b.timer)
    buffers.clear()
    for (const d of disposers) {
      try { if (typeof d === "function") d() } catch (e) {}
    }
    disposers.length = 0
  }

  // 初始化：监听会话事件（global 监听，主会话过滤自己做）
  try {
    disposers.push(ctx.on("session/event", onSessionEvent, { global: true }))
  } catch (e) {
    degraded = "session/event 监听失败"
    warn(`[claw-space] 自动记忆无法监听会话事件: ${e?.message || e}`)
  }
  try {
    disposers.push(ctx.on("session/disposed", onSessionDisposed, { global: true }))
  } catch (e) {
    warn(`[claw-space] 自动记忆无法监听会话销毁: ${e?.message || e}`)
  }

  return { snapshot, setConfig, dispose }
}
