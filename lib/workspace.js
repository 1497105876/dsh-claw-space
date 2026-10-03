// lib/workspace.js — OpenClaw 式常驻 workspace 文件族管理（核心模块）。
//
// 职责：
//   1. ~/.dsh/openclaw/ 下的文件族读取/缓存/注册（host scope 一次注册全局生效）
//   2. 布局（拍板 2026-10-03）：section = IDENTITY/USER/TOOLS/AGENTS；
//      context = MEMORY（仅主会话）/ HEARTBEAT（有任务才注入）；SOUL 移除
//   3. daily notes 最近 2 篇每篇截断；MEMORY mainOnly 依赖 M1 探针结论（text 回调 args[0].agent）
//   4. 人设库存 personas/ 与生效文件之间的切换/保存/新建/删除（原子写，IDENTITY+USER 两件）
//   5. 首启脚手架 seed（只建不覆盖）
//
// 设计与机制结论：docs/02-功能与预期清单.md。

import fs from "node:fs"
import path from "node:path"

/** section 类：进系统提示词（拍板 2026-10-03：IDENTITY/USER/TOOLS/AGENTS 全进系统提示词，SOUL 移除）。 */
const PERSONA_FILES = [
  { file: "IDENTITY.md", name: "openclaw:identity", order: 0, bound: true }, // AI 的人设（随魂）
  { file: "USER.md", name: "openclaw:user", order: 1, bound: true }, // 对用户的描述（随魂）
  { file: "TOOLS.md", name: "openclaw:tools", order: 2 }, // 恒全局
  { file: "AGENTS.md", name: "openclaw:agents", order: 3 }, // 恒全局
]

/** context 类：进运行时上下文（官方投影通道）。 */
const CONTEXT_FILES = [
  { file: "MEMORY.md", name: "openclaw:memory", order: 70, mainOnly: true },
  { file: "HEARTBEAT.md", name: "openclaw:heartbeat", order: 120, heartbeatOnlyWhenNonEmpty: true },
]

/** 人设切换只动这两件（IDENTITY=AI 人设，USER=用户描述）。 */
const PERSONA_PAIR = ["IDENTITY.md", "USER.md"]

/** 多魂绑定表（M5：sessionId → 人设名）。点开头，面板文件列表与 .current 一样隐藏。 */
const BINDINGS_FILE = ".soul-bindings.json"

/** 面板设置（当前只有全局默认人设注入开关）。点开头，不进面板文件列表。 */
const SETTINGS_FILE = ".settings.json"

/** 每文件注入字符上限默认值（perFileLimits 可覆盖）。 */
const DEFAULT_LIMITS = {
  "IDENTITY.md": 4000,
  "USER.md": 4000,
  "TOOLS.md": 4000,
  "AGENTS.md": 4000,
  "MEMORY.md": 6000,
}
const DAILY_NOTE_MAX_CHARS = 8000

// ────────────────────────────────────────────────────────────────
//  小工具
// ────────────────────────────────────────────────────────────────

/** 原子写：临时文件 + rename，崩溃不留半截文件。 */
function writeFileAtomic(absPath, content) {
  const tmp = absPath + ".tmp-" + Date.now()
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(tmp, content, "utf8")
  fs.renameSync(tmp, absPath)
}

function safeReadFile(absPath) {
  try { return fs.readFileSync(absPath, "utf8") } catch (e) { return null }
}

function copyIfSrcExists(src, dest) {
  try {
    if (!fs.existsSync(src)) return false
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(src, dest)
    return true
  } catch (e) { return false }
}

/** HEARTBEAT 是否有实际任务：过滤空行 / HTML 注释 / 标题行后仍有正文才算。 */
function heartbeatHasRealTasks(content) {
  if (!content) return false
  for (const line of content.split("\n")) {
    const t = line.trim()
    if (!t) continue
    if (t.startsWith("<!--")) continue
    if (t.startsWith("#")) continue
    return true
  }
  return false
}

/**
 * 主会话判断（M1 探针结论：text 回调 args[0].agent 可达，header 字段缺失时保守放行）。
 * @returns boolean
 */
function isMainSession(agent) {
  const h = agent?.session?.header
  if (!h) return true // header 不可达：保守按主会话处理（设计文档 §6.1 fallback）
  return !h.parentSession && (h.delegationDepth === undefined || h.delegationDepth === 0)
}

/** 人设名合法性：禁路径分隔符与 ..，防越目录。 */
function validPersonaName(name) {
  const n = String(name || "").trim()
  if (!n || n.length > 64) return false
  if (/[\\/:*?"<>|]/.test(n)) return false
  if (n === "." || n === ".." || n.startsWith(".")) return false
  return true
}

// ────────────────────────────────────────────────────────────────
//  seed 模板（首启脚手架，只建不覆盖）
// ────────────────────────────────────────────────────────────────

const SEEDS = {
  "IDENTITY.md": "# IDENTITY — AI 的人设\n\n> 这里写「这个 AI 是谁」：名字、性格、语气、边界。\n> 由面板「人设管理」切换；agent 可在对话中演化它，演化后用「新建人设（从当前拷贝）」存档。\n",
  "USER.md": "# USER — 用户画像\n\n> 关于「你是谁」：称呼、偏好、习惯、约定。\n",
  "TOOLS.md": "# TOOLS — 常驻工具约定\n\n> 恒全局：任何会话、任何 cwd 都注入。写跨项目通用的工具使用约定。\n",
  "AGENTS.md": "# AGENTS — 工作区协议\n\n> 恒全局：agent 的通用行为协议。\n> 注意：会话 cwd 下的 AGENTS.md 由官方 dsh-agent-instructions 加载，两处内容请勿重复。\n",
  "MEMORY.md": "# MEMORY — 长期记忆\n\n> 全局共享（仅主会话注入，子代理不可见）。\n> 每条一行精炼事实；长了会被截断（完整内容 agent 可按注入标签的路径自行读取）。\n",
  "HEARTBEAT.md": "# HEARTBEAT\n\n> 有实际任务时才注入（空文件/纯注释不注入）。\n",
  "inject.md": "# @gw/dsh-claw-space — 文字注入配置（inject.md）\n#\n# 块头写法：## [system] 标题   或   ## [context] 标题\n# 可选元数据：描述 / 排序 / 启用（详见 lib/parser.js 头注释）\n",
}

// ────────────────────────────────────────────────────────────────
//  管理器
// ────────────────────────────────────────────────────────────────

/**
 * 创建 workspace 管理器。
 * @param opts `{ dir, sp, log, warn, dailyNoteLimit?, perFileLimits? }`
 */
export function createWorkspaceManager({ dir, sp, log, warn, dailyNoteLimit = 2, perFileLimits = {} }) {
  const limits = { ...DEFAULT_LIMITS, ...(perFileLimits || {}) }
  let cache = new Map() // file -> string | null；"memory/*.md" -> [{name, text}]
  let bindings = {} // sessionId -> 人设名（多魂绑定表，M5）
  let settings = { injectionEnabled: true } // 插件注入总开关（拍板 2026-10-04：关 = 本插件全部段不注入）
  let disposers = []
  let disposed = false
  let lastLoadAt = null

  const abs = (...p) => path.join(dir, ...p)

  // ── 目录 / seed ──────────────────────────────────────────
  function ensureWorkspace() {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.mkdirSync(abs("personas"), { recursive: true })
      fs.mkdirSync(abs("memory"), { recursive: true })

      // seed 占位：只建不覆盖
      for (const [f, content] of Object.entries(SEEDS)) {
        const p = abs(f)
        if (!fs.existsSync(p)) {
          fs.writeFileSync(p, content, "utf8")
          log(`[claw-space] 已创建占位文件 ${f}`)
        }
      }
      // .current 指针
      if (!fs.existsSync(abs(".current"))) fs.writeFileSync(abs(".current"), "", "utf8")
    } catch (e) {
      warn(`[claw-space] 初始化 workspace 目录失败: ${e?.message}`)
    }
  }

  // ── 读取与截断 ────────────────────────────────────────────
  function readTruncatedAbs(absPath, maxChars) {
    const t = safeReadFile(absPath)
    if (t === null) return null
    if (maxChars && t.length > maxChars) {
      return t.slice(0, maxChars) + `\n\n[...truncated，完整内容见 ${absPath}]`
    }
    return t
  }

  function readTruncated(relFile, maxChars) {
    return readTruncatedAbs(abs(relFile), maxChars)
  }

  function loadDailyNotes() {
    let entries = []
    try { entries = fs.readdirSync(abs("memory")) } catch (e) { return [] }
    return entries
      .filter((n) => /\.md$/i.test(n))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, dailyNoteLimit)
      .map((n) => {
        let text = safeReadFile(abs("memory", n))
        if (text === null) return null
        if (text.length > DAILY_NOTE_MAX_CHARS) {
          text = text.slice(0, DAILY_NOTE_MAX_CHARS) + `\n\n[...truncated，完整内容见 ${abs("memory", n)}]`
        }
        return { name: n, text }
      })
      .filter((x) => x !== null)
  }

  function refreshCache() {
    cache = new Map()
    for (const f of [...PERSONA_FILES, ...CONTEXT_FILES]) {
      cache.set(f.file, readTruncated(f.file, limits[f.file]))
    }
    cache.set("memory/*.md", loadDailyNotes())
    loadBindings() // 绑定表也归热加载管（手改 .soul-bindings.json 同样生效）
    loadSettings() // 开关同理（手改 .settings.json 生效）
    lastLoadAt = new Date().toISOString()
  }

  // ── 注册 ──────────────────────────────────────────────────
  function reminder(label, text) {
    return "<system-reminder>\n" + label + "\n\n" + text + "\n</system-reminder>"
  }

  function labelFor(f) {
    if (f.mainOnly) return `OpenClaw long-term memory (${abs(f.file)}) — main-session only, never injected into sub-agents.`
    return `OpenClaw workspace file: ${abs(f.file)}`
  }

  // ── 多魂绑定（M5：D8 /user；D9 子代理继承；D10 缺件留空；D11 实时读库存）───
  function loadBindings() {
    const raw = safeReadFile(abs(BINDINGS_FILE))
    if (raw === null || !raw.trim()) { bindings = {}; return }
    try {
      const obj = JSON.parse(raw)
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const clean = {}
        for (const [k, v] of Object.entries(obj)) {
          if (typeof k === "string" && k && typeof v === "string" && v) clean[k] = v
        }
        bindings = clean
      } else {
        bindings = {}
      }
    } catch (e) {
      bindings = {} // 坏 JSON 不炸插件，等下次合法写入重建
    }
  }

  // ── 注入总开关（拍板 2026-10-04：关 = 本插件全部段不注入，面板编辑不受影响）──
  function loadSettings() {
    const raw = safeReadFile(abs(SETTINGS_FILE))
    if (raw === null || !raw.trim()) { settings = { injectionEnabled: true }; return }
    try {
      const obj = JSON.parse(raw)
      if (!obj || typeof obj !== "object") { settings = { injectionEnabled: true }; return }
      // 旧键 personaEnabled 兼容（开关语义升级前曾只管人设三件）
      if ("injectionEnabled" in obj) settings = { injectionEnabled: obj.injectionEnabled !== false }
      else if ("personaEnabled" in obj) settings = { injectionEnabled: obj.personaEnabled !== false }
      else settings = { injectionEnabled: true }
    } catch (e) {
      settings = { injectionEnabled: true } // 坏 JSON 回落默认开
    }
  }

  function saveSettings() {
    try {
      writeFileAtomic(abs(SETTINGS_FILE), JSON.stringify(settings, null, 2) + "\n", "utf8")
      return null
    } catch (e) {
      return `设置写入失败：${e?.message}`
    }
  }

  function setInjectionEnabled(v) {
    settings.injectionEnabled = !!v
    const err = saveSettings()
    if (err) return { ok: false, error: err }
    return { ok: true, injectionEnabled: settings.injectionEnabled }
  }

  /** 注入总开关：关闭时本插件所有段（人设/记忆/日志/自由块）一律返回空。 */
  function injectEnabled() { return !!settings.injectionEnabled }

  function saveBindings() {
    try {
      writeFileAtomic(abs(BINDINGS_FILE), JSON.stringify(bindings, null, 2) + "\n", "utf8")
      return null
    } catch (e) {
      return `绑定表写入失败：${e?.message}`
    }
  }

  /** agent 的会话身份（SessionId 是持久化 branded string，会话恢复后不变）。 */
  function sessionIdOf(agent) {
    const s = agent && agent.session
    const id = (s && s.id) || (s && s.header && s.header.id) || null
    return id ? String(id) : null
  }

  /**
   * 解析 agent 应生效的绑定人设：
   * 子代理先看父会话（D9 继承），再看自身；主会话只看自身。
   * @returns 人设名 | null（未绑定 → 跟随全局默认）
   */
  function resolveBinding(agent) {
    if (!agent) return null
    const h = agent.session && agent.session.header
    const parentId = h && h.parentSession ? String(h.parentSession) : null
    if (parentId && bindings[parentId]) return bindings[parentId]
    const own = sessionIdOf(agent)
    if (own && bindings[own]) return bindings[own]
    return null
  }

  /** 写/删一条绑定。persona 传空 = 解绑。 */
  function setBinding(sessionId, persona) {
    const sid = String(sessionId || "").trim()
    if (!sid) return { ok: false, error: "会话身份为空，无法绑定" }
    if (persona === null || persona === undefined || persona === "") {
      const existed = sid in bindings
      delete bindings[sid]
      if (existed) {
        const err = saveBindings()
        if (err) return { ok: false, error: err }
      }
      return { ok: true, unbound: true }
    }
    const name = String(persona).trim()
    const err = personaErrors(name)
    if (err) return { ok: false, error: err }
    if (!fs.existsSync(abs("personas", name))) return { ok: false, error: `库存里没有「${name}」` }
    bindings[sid] = name
    const saveErr = saveBindings()
    if (saveErr) return { ok: false, error: saveErr }
    return { ok: true, persona: name }
  }

  function clearBindings() {
    const cleared = Object.keys(bindings).length
    bindings = {}
    const err = saveBindings()
    if (err) return { ok: false, error: err }
    return { ok: true, cleared }
  }

  /**
   * 人设两件（IDENTITY/USER）按 agent 解析注入来源：
   * 绑定 → 实时读库存（缺件留空，D10）；未绑定/无 agent（预览）→ 根目录生效文件。
   * @returns `{ text, source, bound }`，source = 实际来源绝对路径（供段内标注）
   */
  function serveTrioPiece(f, agent) {
    const persona = agent ? resolveBinding(agent) : null
    if (persona) {
      const p = abs("personas", persona, f.file)
      const raw = safeReadFile(p)
      if (raw === null || !raw) return { text: "", source: null, bound: persona } // D10：缺件/空件留空
      const limit = limits[f.file]
      const text = limit && raw.length > limit
        ? raw.slice(0, limit) + `\n\n[...truncated，完整内容见 ${p}]`
        : raw
      return { text, source: p, bound: persona }
    }
    return { text: cache.get(f.file) || "", source: abs(f.file), bound: null }
  }

  /**
   * 系统提示词段正文：首行带来源文件标注（拍板 2026-10-03）——
   * section 是裸文本注入，不标路径 agent 就不知道「改哪段要编辑哪个文件」。
   * HTML 注释形式：模型可读、不算正文。
   */
  function sectionText(f, agent) {
    if (!injectEnabled()) return "" // 注入总开关：关 = 本插件全部段不注入
    const piece = f.bound
      ? serveTrioPiece(f, agent)
      : { text: cache.get(f.file) || "", source: abs(f.file) }
    if (!piece.text) return ""
    return `<!-- claw-space 来源: ${piece.source} ｜ 编辑此文件即修改本段，下一轮生效 -->\n\n${piece.text}`
  }

  function registerAll() {
    for (const d of disposers) {
      try { if (typeof d === "function") d() } catch (e) {}
    }
    disposers = []
    if (disposed) return
    if (!sp || typeof sp.section !== "function" || typeof sp.context !== "function") {
      warn("[claw-space] systemPrompt 服务不可用，workspace 注入未生效")
      return
    }

    // section 类（IDENTITY / USER / TOOLS / AGENTS）——IDENTITY/USER 随魂：按 agent 绑定改读库存
    // interpolate: false——正文来自用户手写文件，含 {{xxx}} 时不能走官方变量插值
    //（未注册变量会 throw，炸掉整个 assemble）；本插件不使用提示词变量
    for (const f of PERSONA_FILES) {
      disposers.push(sp.section({
        name: f.name,
        order: f.order,
        interpolate: false,
        text: function (args) {
          const agent = args && args[0] && args[0].agent
          return sectionText(f, agent)
        },
      }))
    }

    // context 类（MEMORY / HEARTBEAT）
    for (const f of CONTEXT_FILES) {
      disposers.push(sp.context({
        name: f.name,
        order: f.order,
        interpolate: false,
        text: function (args) {
          if (!injectEnabled()) return "" // 注入总开关
          if (f.mainOnly) {
            // 探针结论：真实请求 args[0] = {agent}；全局预览 args[0] = {}
            const agent = args && args[0] && args[0].agent
            if (!agent) return "" // 无 agent 上下文（预览等场景）：保守不注入
            if (!isMainSession(agent)) return "" // 子代理/群聊：不注入
          }
          const c = cache.get(f.file)
          if (!c) return ""
          if (f.heartbeatOnlyWhenNonEmpty && !heartbeatHasRealTasks(c)) return ""
          return reminder(labelFor(f), c)
        },
      }))
    }

    // daily notes
    disposers.push(sp.context({
      name: "openclaw:daily",
      order: 80,
      interpolate: false,
      text: function () {
        if (!injectEnabled()) return "" // 注入总开关
        const notes = cache.get("memory/*.md") || []
        if (!notes.length) return ""
        return notes.map((n) => reminder(`OpenClaw daily note: ${abs("memory", n.name)}`, n.text)).join("\n")
      },
    }))

    log(`[claw-space] workspace 注入已注册：${PERSONA_FILES.length} 个 section + ${CONTEXT_FILES.length + 1} 个 context`)
  }

  // ── 人设操作（拍板 2026-10-03：只动 IDENTITY/USER 两件）───
  function listPersonas() {
    try {
      return fs.readdirSync(abs("personas"), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    } catch (e) { return [] }
  }

  function readCurrent() {
    const c = safeReadFile(abs(".current"))
    return (c || "").trim()
  }

  function writeCurrent(name) {
    writeFileAtomic(abs(".current"), name || "")
  }

  /** 清空指针：回到「未命名默认」——全局默认 = 根目录文件本身，与库存解绑。 */
  function clearCurrent() {
    writeCurrent("")
    refreshCache()
    registerAll()
    return { ok: true }
  }

  function personaErrors(name) {
    if (!validPersonaName(name)) return "人设名不合法（禁止空名/路径分隔符/以点开头，长度 ≤64）"
    return null
  }

  function switchPersona(name) {
    const err = personaErrors(name)
    if (err) return { ok: false, error: err }
    if (!fs.existsSync(abs("personas", name))) return { ok: false, error: `库存里没有「${name}」` }

    const warnings = []
    const current = readCurrent()
    // ① 当前生效两件备份回旧库存（保留对话中演化的人设）。
    //    注意：绑定会话可能直接演化过库存（D11 实时读库存），此时库存与全局默认
    //    会分叉——盲目用根目录覆盖库存会把绑定会话的演化冲掉，所以内容有分歧时
    //    保留库存版本并警告（想把全局默认存进库存请用「新建人设（从当前拷贝）」）。
    if (current && current !== name) {
      for (const f of PERSONA_PAIR) {
        const src = abs(f)
        if (!fs.existsSync(src)) { warnings.push(`${f} 备份回「${current}」时根目录不存在，已跳过`); continue }
        const stockRaw = safeReadFile(abs("personas", current, f))
        const rootRaw = safeReadFile(src)
        if (stockRaw !== null && rootRaw !== null && stockRaw !== rootRaw) {
          warnings.push(`${f}：库存「${current}」与全局默认内容有分歧，已保留库存版本（全局默认的改动未写入库存，需要的话用「新建人设（从当前拷贝）」存档）`)
          continue
        }
        copyIfSrcExists(src, abs("personas", current, f))
      }
    }
    // ② 新库存两件换入根目录（缺失的跳过）
    for (const f of PERSONA_PAIR) {
      if (!copyIfSrcExists(abs("personas", name, f), abs(f))) warnings.push(`「${name}」缺少 ${f}，根目录保持原样`)
    }
    // ③ 指针 + 刷新
    writeCurrent(name)
    refreshCache()
    registerAll()
    // 未命名默认（.current 为空）直接被替换：根目录内容没存过任何库存，提醒一下
    if (!current && fs.existsSync(abs("IDENTITY.md"))) {
      warnings.push("此前为未命名默认（未指向库存），根目录内容已被「" + name + "」替换且未存档；要保留请用「新建人设（从当前拷贝）」")
    }
    return { ok: true, current: name, warnings }
  }

  function newPersona(name, { fromCurrent = false } = {}) {
    const err = personaErrors(name)
    if (err) return { ok: false, error: err }
    if (fs.existsSync(abs("personas", name))) return { ok: false, error: `「${name}」已存在` }
    if (fromCurrent) {
      for (const f of PERSONA_PAIR) copyIfSrcExists(abs(f), abs("personas", name, f))
    } else {
      fs.mkdirSync(abs("personas", name), { recursive: true })
      for (const f of PERSONA_PAIR) {
        if (!fs.existsSync(abs("personas", name, f))) {
          fs.writeFileSync(abs("personas", name, f), SEEDS[f] || "", "utf8")
        }
      }
    }
    return { ok: true, name }
  }

  function deletePersona(name) {
    const err = personaErrors(name)
    if (err) return { ok: false, error: err }
    if (!fs.existsSync(abs("personas", name))) return { ok: false, error: `「${name}」不存在` }
    const current = readCurrent()
    fs.rmSync(abs("personas", name), { recursive: true, force: true })
    // 绑定到此人设的会话自动解绑（库存没了，绑定就是悬空的）
    const unbound = Object.keys(bindings).filter((sid) => bindings[sid] === name)
    for (const sid of unbound) delete bindings[sid]
    if (unbound.length) saveBindings()
    if (current === name) writeCurrent("") // 删的是当前人设 → 清空指针
    const warnings = unbound.length ? [`已自动解绑 ${unbound.length} 个会话的 /user 绑定`] : []
    return { ok: true, warnings }
  }

  // ── 面板快照（M3 路由用）─────────────────────────────────
  function snapshot() {
    const files = [...PERSONA_FILES, ...CONTEXT_FILES].map((f) => {
      const c = cache.get(f.file)
      return {
        file: f.file, name: f.name, order: f.order,
        exists: c !== null, chars: c ? c.length : 0,
        limit: limits[f.file] || 0,
        mainOnly: !!f.mainOnly,
      }
    })
    return {
      dir,
      current: readCurrent(),
      personas: listPersonas(),
      bindings: { ...bindings },
      settings: { ...settings },
      files,
      dailyNotes: (cache.get("memory/*.md") || []).map((n) => ({ name: n.name, chars: n.text.length })),
      lastLoadAt,
    }
  }

  function dispose() {
    disposed = true
    for (const d of disposers) {
      try { if (typeof d === "function") d() } catch (e) {}
    }
    disposers = []
  }

  // 初始化
  ensureWorkspace()
  refreshCache()
  registerAll()

  return {
    dir,
    registerAll, refreshCache, snapshot, dispose,
    // 预览专用：段名 → 文件原文（不做 mainOnly/门控/截断，文件里是啥样就显示啥样）。
    // 只有 context 三段会用到（mainOnly/门控在全局装配中可能为空，原文作「文件视角」补充）；
    // section 四段走真实注入文本（含来源标注），不在此列。
    segmentTextFor(name) {
      const map = {
        "openclaw:memory": "MEMORY.md",
        "openclaw:heartbeat": "HEARTBEAT.md",
      }
      const f = map[name]
      if (f) return safeReadFile(abs(f))
      if (name === "openclaw:daily") {
        let entries = []
        try { entries = fs.readdirSync(abs("memory")) } catch (e) {}
        return entries
          .filter((n) => /\.md$/i.test(n))
          .sort((a, b) => b.localeCompare(a))
          .slice(0, dailyNoteLimit)
          .map((n) => "===== " + n + " =====\n" + (safeReadFile(abs("memory", n)) || ""))
          .join("\n\n")
      }
      return null
    },
    listPersonas, readCurrent, switchPersona, newPersona, deletePersona, clearCurrent,
    // 多魂绑定（M5）：/user 命令与面板共用
    sessionIdOf, resolveBinding, setBinding, clearBindings,
    bindingsSnapshot: () => ({ ...bindings }),
    // 注入总开关（面板 toggle）
    injectEnabled, setInjectionEnabled,
    listFiles() {
      // 递归列出 workspace 全部相对路径（面板文件树用）
      const out = []
      const walk = (rel) => {
        const p = rel ? abs(rel) : dir
        let entries = []
        try { entries = fs.readdirSync(p, { withFileTypes: true }) } catch (e) { return }
        for (const e of entries) {
          if (e.name === ".current" || e.name === BINDINGS_FILE || e.name === SETTINGS_FILE) continue // 指针/绑定表/设置不进面板
          const relChild = rel ? rel + "/" + e.name : e.name
          if (e.isDirectory()) { out.push({ path: relChild, dir: true }); walk(relChild) }
          else out.push({ path: relChild, dir: false })
        }
      }
      walk("")
      return out
    },
  }
}
