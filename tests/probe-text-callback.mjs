// tests/probe-text-callback.mjs — 用本机真实 dsh-system-prompt 验证
// section/context 的 text 回调实参形状（P0-1 防复发回归探针）。
//
// 结论（dsh 0.2.0-rc.2，2026-10-11 实测）：text 回调是单参数调用，
// 参数为普通对象 {agent, scope}（真实请求，等价 dsh-agent 的 assembleContextFor）
// 或 {}（全局预览）——不是数组。workspace.js 注入回调必须按 ctx.agent 取 agent。
// 早期「args[0] = {agent}」的数组形状是误判，曾导致 MEMORY 永不注入、/user 多魂失效。
//
// 运行：node tests/probe-text-callback.mjs
// 依赖本机安装的 @deepseek-ai/dsh；可用 DSH_PKG_BASE 覆盖包基址。
// 任一断言失败退出码 1，可挂进冒烟/CI。

const BASE = process.env.DSH_PKG_BASE
  || "file:///C:/Users/highness/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai"

const { SystemPrompt } = await import(BASE + "/dsh-system-prompt/lib/index.js")
const { Context } = await import(BASE + "/cordis/lib/index.js")

const seen = []
const probe = (fn) => (...a) => (seen.push({ fn, argc: a.length, arg0: a[0] }), "x")

const sp = new SystemPrompt(new Context(), { toolOrder: ["<unlisted-tools>"] })
sp.section({ name: "probe:section", order: 30, interpolate: false, text: probe("section.text") })
sp.context({ name: "probe:context", order: 10, interpolate: false, text: probe("context.text") })

const fakeAgent = { id: "x", session: { id: "s1", header: { id: "s1" } } }
await sp.assemble({})                                     // 预览场景
await sp.assemble({ agent: fakeAgent, scope: fakeAgent }) // 真实请求场景

let fail = 0
function assert(cond, msg) {
  if (cond) { console.log("PASS " + msg); return }
  fail++
  console.error("FAIL " + msg)
}

assert(seen.length === 4, "预览 + 真实请求各触发 section/context 回调一次（共 4 次）")
for (const s of seen) {
  assert(s.argc === 1, `${s.fn}: 单参数调用（argc=1）`)
  assert(s.arg0 && typeof s.arg0 === "object" && !Array.isArray(s.arg0),
    `${s.fn}: 参数是非数组对象（不是 args[0] 数组形状）`)
}
const real = seen.filter((s) => s.arg0 && s.arg0.agent)
assert(real.length === 2, "真实请求下两个回调都能拿到 agent")
for (const s of real) {
  assert(s.arg0.agent === fakeAgent, `${s.fn}: arg0.agent 即传入的 agent`)
  assert(s.arg0.scope === fakeAgent, `${s.fn}: arg0.scope 即传入的 scope`)
}

if (fail) {
  console.error(`\n${fail} 项断言失败：回调形状与预期不符，workspace.js 取 agent 的方式需要重查`)
  process.exit(1)
}
console.log("\n回调形状符合预期：text(ctx)，agent = ctx.agent")
