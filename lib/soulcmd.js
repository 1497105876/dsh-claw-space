// lib/soulcmd.js — /user 斜杠命令：会话级人设绑定（多魂并行，M5）。
//
// 拍板（2026-10-03）：命令名 /user（D8）；子代理继承父会话绑定（D9）；绑定缺件
// 留空（D10）；绑定实时读库存（D11）；人设 = IDENTITY + USER 两件（布局拍板，SOUL 移除）。
//
// commands 服务（@deepseek-ai/dsh-commands，cordis 服务名 "commands"）由 dsh
// 核心提供：register({ name, description, input, handler })，handler 收
// { commandId, agent, rawInput, signal }，返回 { kind:'success'|'error', text }。
// 服务拿不到就整体不注册（软降级），单魂注入不受影响。绑定表读写全在
// workspace.js；命令只写绑定表，下一轮请求自然生效，无需重注册段。
//
// 用动态 ctx.get 取服务而不进静态 inject：避免个别 profile 缺该服务时整
// 插件加载失败（同 routes.js 取 agents 的既有模式）。

export function registerSoulCommand({ commands, workspace, log, warn }) {
  if (!commands || typeof commands.register !== "function") {
    warn("[claw-space] commands 服务不可用，/user 命令未注册（会话级人设绑定不可用，注入不受影响）")
    return null
  }

  function listText(agent) {
    const bound = workspace.resolveBinding(agent)
    const current = workspace.readCurrent()
    const stock = workspace.listPersonas()
    const lines = []
    lines.push(bound
      ? `本会话绑定：「${bound}」`
      : `本会话未绑定（跟随全局默认${current ? `「${current}」` : "，未命名人设"}）`)
    lines.push(`库存人设：${stock.length ? stock.map((n) => (n === bound ? n + "（当前）" : n)).join("、") : "（空）"}`)
    lines.push("切换：/user <人设名>；解绑回全局默认：/user off")
    return lines.join("\n")
  }

  try {
    const disposer = commands.register({
      name: "user",
      description: "切换本会话的人设（OpenClaw 多魂）；参数：人设名 | off | 留空查看",
      input: { hint: "人设名 / off（留空查看当前绑定）" },
      handler(invocation) {
        const agent = invocation && invocation.agent
        const sid = workspace.sessionIdOf(agent)
        if (!sid) return { kind: "error", text: "拿不到会话身份，无法绑定人设" }
        const raw = String((invocation && invocation.rawInput) || "").trim()
        if (!raw) return { kind: "success", text: listText(agent) }
        if (raw === "off") {
          const r = workspace.setBinding(sid, null)
          if (!r.ok) return { kind: "error", text: r.error }
          return { kind: "success", text: "已解绑，本会话回到全局默认人设（下一轮生效）" }
        }
        const r = workspace.setBinding(sid, raw)
        if (!r.ok) return { kind: "error", text: r.error }
        return {
          kind: "success",
          text: `本会话已绑定人设「${raw}」，下一轮生效。IDENTITY / USER 将改从该库存实时读取（缺件留空）；/user off 可解绑。`,
        }
      },
    })
    log("[claw-space] /user 命令已注册（会话级人设绑定可用）")
    return disposer
  } catch (e) {
    warn(`[claw-space] /user 命令注册失败（可能与其他插件重名）: ${e?.message}`)
    return null
  }
}
