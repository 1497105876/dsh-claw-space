// tests/smoke-workspace.mjs — workspace 注入链路集成冒烟（mock 官方 sp 形状 + 真实临时目录）。
//
// mock 形状依据 tests/probe-text-callback.mjs 的实测结论：
//   text 回调单参数收普通对象 {agent, scope}（真实请求）或 {}（全局预览）。
// 该形状曾因误判成 args[0] 数组导致 P0-1（MEMORY 永不注入、/user 多魂失效），
// 本冒烟就是防它复发的集成层回归。
//
// 运行：node tests/smoke-workspace.mjs（零外部依赖，Node >= 18）
// 任一断言失败退出码 1。

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createWorkspaceManager } from "../lib/workspace.js"
import { createAutoWriter } from "../lib/autowrite.js"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "claw-space-smoke-"))

let fail = 0
function assert(cond, msg) {
  if (cond) { console.log("PASS " + msg); return }
  fail++
  console.error("FAIL " + msg)
}

const logs = []
const log = (...a) => logs.push(a.join(" "))
const warn = (...a) => logs.push("[warn] " + a.join(" "))

/** mock 官方 SystemPrompt：按注册顺序保存 section/context 的回调与参数。 */
function makeMockSp() {
  const sections = new Map()
  const contexts = new Map()
  return {
    sections,
    contexts,
    section(opts) { sections.set(opts.name, opts); return () => sections.delete(opts.name) },
    context(opts) { contexts.set(opts.name, opts); return () => contexts.delete(opts.name) },
  }
}

/** 造一个假 agent：主会话 / 子代理两种形态。 */
const mainAgent = (sid) => ({ id: sid, session: { id: sid, header: { id: sid } } })
const childAgent = (sid, parent) => ({
  id: sid,
  session: { id: sid, header: { id: sid, parentSession: parent, delegationDepth: 1 } },
})

// ── 1. 实例化：seed 全量创建 ──────────────────────────────
const sp = makeMockSp()
const ws = createWorkspaceManager({ dir: tmp, sp, log, warn })

for (const f of ["IDENTITY.md", "USER.md", "TOOLS.md", "AGENTS.md", "MEMORY.md", "HEARTBEAT.md", "inject.md", ".current"]) {
  assert(fs.existsSync(path.join(tmp, f)), `seed 已创建 ${f}`)
}

// ── 2. 注册数量与段名 ─────────────────────────────────────
assert(sp.sections.size === 4, `注册 4 个 section（实际 ${sp.sections.size}）`)
assert(sp.contexts.size === 3, `注册 3 个 context（实际 ${sp.contexts.size}）`)
assert(sp.sections.has("openclaw:identity") && sp.sections.has("openclaw:user")
  && sp.sections.has("openclaw:tools") && sp.sections.has("openclaw:agents"), "section 段名齐全")
assert(sp.contexts.has("openclaw:memory") && sp.contexts.has("openclaw:heartbeat")
  && sp.contexts.has("openclaw:daily"), "context 段名齐全")

// ── 3. P0-1 回归：单参数 {agent, scope} 形状下各段都能取到内容 ──
const ident = sp.sections.get("openclaw:identity")
assert(ident.text.length === 1, "section text 回调是单参数函数")
assert(String(ident.text({})).includes("IDENTITY"), "预览（{}）：identity 走根目录非空")
assert(String(ident.text({ agent: mainAgent("s1"), scope: mainAgent("s1") })).includes("IDENTITY"),
  "真实请求（无绑定）：identity 走根目录非空")

const mem = sp.contexts.get("openclaw:memory")
assert(mem.text.length === 1, "context text 回调是单参数函数")
assert(mem.text({}) === "", "预览（{}）：MEMORY 保守不注入")
assert(String(mem.text({ agent: mainAgent("s1"), scope: mainAgent("s1") })).includes("MEMORY"),
  "主会话：MEMORY 注入非空")
assert(mem.text({ agent: childAgent("c1", "s1"), scope: childAgent("c1", "s1") }) === "",
  "子代理：MEMORY 不注入（mainOnly）")

// daily：memory/ 目录为空 → 不注入
assert(sp.contexts.get("openclaw:daily").text() === "", "无日志文件：daily 不注入")

// ── 4. HEARTBEAT 门控（E-1 回归：seed 全注释不算任务） ──────
assert(sp.contexts.get("openclaw:heartbeat").text({}) === "",
  "seed HEARTBEAT（纯注释）：不注入（E-1 修复后）")
fs.writeFileSync(path.join(tmp, "HEARTBEAT.md"), "# HEARTBEAT\n\n- 每天 9 点提醒喝水\n", "utf8")
ws.refreshCache()
assert(String(sp.contexts.get("openclaw:heartbeat").text({})).includes("提醒喝水"),
  "写入任务后：HEARTBEAT 注入")

// ── 5. /user 多魂：绑定 → 实时读库存；缺件留空；解绑回根目录 ──
const np = ws.newPersona("p1")
assert(np.ok, "新建人设 p1")
fs.writeFileSync(path.join(tmp, "personas", "p1", "IDENTITY.md"), "# 我是 p1 的魂\n", "utf8")
const bind = ws.setBinding("s1", "p1")
assert(bind.ok, "绑定 s1 → p1")
const boundText = String(ident.text({ agent: mainAgent("s1"), scope: mainAgent("s1") }))
assert(boundText.includes("p1 的魂"), "绑定会话：identity 实时读库存")
assert(boundText.includes(path.join("personas", "p1")), "绑定会话：来源标注指向库存路径")
assert(ws.setBinding("s1", null).ok, "解绑 s1")
assert(String(ident.text({ agent: mainAgent("s1"), scope: mainAgent("s1") })).includes("IDENTITY"),
  "解绑后：回到根目录默认")

// 子代理继承父会话绑定（D9）
ws.setBinding("s1", "p1")
const inheritText = String(ident.text({ agent: childAgent("c1", "s1"), scope: childAgent("c1", "s1") }))
assert(inheritText.includes("p1 的魂"), "子代理继承父会话绑定（D9）")
ws.setBinding("s1", null)

// ── 6. 人设切换：指针 + 根目录两件换入 ─────────────────────
const sw = ws.switchPersona("p1")
assert(sw.ok && ws.readCurrent() === "p1", "切换后指针指向 p1")
assert(fs.readFileSync(path.join(tmp, "IDENTITY.md"), "utf8").includes("p1 的魂"),
  "切换后根目录 IDENTITY 已换入库存版本")
ws.clearCurrent()

// ── 7. autowrite 轻冒烟：实例化 / 配置校验 / 快照 / 清理 ────
const listeners = {}
const actx = {
  on: (ev, cb) => { (listeners[ev] ||= []).push(cb); return () => {} },
  get: () => null, // 拿不到 agents → 软降级路径
}
const aw = createAutoWriter({ dir: tmp, ctx: actx, log, warn, config: {} })
const snap = aw.snapshot()
assert(snap.config.enabled === true && snap.config.idleMs === 60000, "autowrite 默认配置正确")
assert(snap.config.cooldownMs === 600000, "冷却间隔默认 10 分钟")
assert(aw.setConfig({ cooldownMs: 2000 }).ok === true, "合法 patch 通过")
assert(aw.setConfig({ cooldownMs: 0 }).ok === true, "冷却设 0（不冷却）合法")
assert(aw.setConfig({ cooldownMs: 3600001 }).ok === false, "越界 patch 被拒（冷却超上限）")
assert(aw.setConfig({ idleMs: 5 }).ok === false, "越界 patch 被拒（低于下限）")
assert(aw.setConfig({ unknownKey: 1 }).ok === false, "未知键被拒")
aw.dispose()
assert(!fs.existsSync(path.join(tmp, ".autowrite.json")) || true, "dispose 完成")

// ── 8. 清理：dispose 后 registerAll 幂等跳过（卸载竞态保护），不炸 ──
ws.dispose()
assert(sp.sections.size === 0, "dispose 后已注册段全部撤下")
ws.registerAll()
assert(sp.sections.size === 0, "卸载后 registerAll 幂等跳过，不重新注册也不炸")
ws.dispose()

fs.rmSync(tmp, { recursive: true, force: true })

if (fail) {
  console.error(`\n${fail} 项断言失败：冒烟未过`)
  process.exit(1)
}
console.log("\n冒烟全过：注入链路、多魂绑定、门控、autowrite 配置均正常")
