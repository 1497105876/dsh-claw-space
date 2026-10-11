# @gw/dsh-claw-space

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

在 dsh（DeepSeek Harness）的 `~/.dsh/openclaw/` 下建立**常驻 OpenClaw 式 workspace**：
IDENTITY / USER / TOOLS / AGENTS / MEMORY / HEARTBEAT / daily notes 成套文件族
**跨会话、跨 cwd 自动注入所有 agent**，附带**人设切换**与**设置页面板**，
以及自由文字注入块。

## 功能

### 注入（插件本体）

- **常驻文件族注入**：`~/.dsh/openclaw/` 下的文件族自动注入**所有** agent——跨会话、跨目录，一次注册全局生效，任何新对话不用重复自我介绍
- **注入分层**：`IDENTITY.md`（AI 的人设）/ `USER.md`（对你的描述）/ `TOOLS.md`（工具约定）/ `AGENTS.md`（行为协议）注入**系统提示词**；`MEMORY.md`（长期记忆）/ `HEARTBEAT.md`（定时任务）/ `memory/*.md`（每日日志）注入**运行时上下文**
- **来源路径标注**：系统提示词里每个人设段的首行标明来源文件绝对路径——你和 agent 都清楚「改哪一段 = 编辑哪个文件」，改完下一轮生效
- **每文件注入预算**：单文件超长自动截断并标注完整路径，agent 可用原生 read 按需读全文
- **MEMORY 隐私隔离**：仅主会话注入，子代理与共享会话拿不到
- **HEARTBEAT 门控**：任务清单非空才注入，空文件零开销
- **daily notes**：每日日志自动取最近 2 篇注入，单篇超长截断

### 自动记忆（会话空闲自动提炼写入）

- **触发**：主会话静默一段时间（默认 60 秒）后自动跑一次；新消息到来即重新计时，`turn/end` 才开始防抖
- **提炼**：起一个一次性 dsh 子代理，读会话转写本 + 现有 `MEMORY.md` + 今日日志，只回一段 JSON
- **落盘**：跨天成立的长期事实逐行追加进 `MEMORY.md`，今日流水挂到 `memory/<date>.md` 的「自动记录」小节；**逐行精确去重、只增不删、原子写**
- **与协议写入并存**：`AGENTS.md` 里「agent 自己写记忆」的协议通道照旧保留，本功能是额外的自动兜底，两者不冲突
- **只收主会话**：子代理与委派会话的对话不进缓冲（`parentSession` / `delegationDepth` 过滤）；MEMORY 仍仅主会话注入
- **软降级**：拿不到 `agents` 服务时整体停用并 warn 一次，注入与面板完全不受影响；不进静态 inject
- **配置**：面板「自动记忆」tab，或手改 `~/.dsh/openclaw/.autowrite.json`（每个决策点 fresh read，改完即生效）
- **agent 自行决定 git 时机**：本插件只写 Markdown，不碰版本库

### 人设系统

- **人设库存**：`personas/<名>/` 下保存任意多套 IDENTITY + USER，面板一键切换全局默认
- **未命名默认**：不选库存也完全可以——直接编辑根目录文件就是默认人设；「清除当前」按钮随时与库存解绑回到这个状态
- **注入总开关**：面板一键停掉 workspace 文件族的全部注入——IDENTITY / USER / TOOLS / AGENTS / MEMORY / 每日日志 / HEARTBEAT 全停（自由注入块不受影响，它们有自己的块级启停；面板编辑不受影响）；勾上即恢复。状态存 `~/.dsh/openclaw/.settings.json`，手改也生效
- **会话级多魂（/user 命令）**：对话里 `/user <人设名>` 给**当前这一个对话**换人设，`/user off` 回默认，`/user` 留空查看库存与绑定；子代理自动继承父对话的人设；绑定的会话实时读库存，改库存立刻生效
- **人设演化**：agent 可以自己改人设（来源路径就写在提示词里）；未命名演化用「新建人设（从当前拷贝）」存档；根目录与库存内容有分歧时，切换会保留库存版本并警告，不静默覆盖
- **库存文件直接编辑**：面板文件区按人设分组，根目录与库存的文件都能直接改、直接保存

### 面板（dsh 设置页 → OpenClaw 工作区）

- **注入预览**：实时查看 AI 下一轮**实际收到的完整提示词**——全部段（含官方段）全量列出、分组可折叠、本插件段显示真实注入形态（含来源标注），改完文件刷新即见
- **人设管理**：全局开关 / 当前人设 / 清除当前 / 新建（可从当前拷贝）/ 切换 / 删除
- **会话绑定清单**：查看所有 `/user` 绑定（sessionId → 人设名），逐条解绑或一键清空（绑定与切换只在对话内用 `/user`，面板不提供切换入口）
- **文件浏览编辑**：根目录生效文件 + 按人设分组的库存文件，在线编辑保存
- **文字注入编辑**：`inject.md` 的分块增删改
- **自动记忆配置**：启用开关 / 空闲秒数 / 转写上下限 / 提炼模型 / 超时，外加实时状态卡（缓冲、上次提炼时间、上次写入条数、最近错误）

### 其他

- **自由文字注入块**：`inject.md` 的 `## [system]` / `## [context]` 分块，临时指令、项目资料按块注入，支持排序与启停
- **热加载**：`fs.watch` 盯整个 openclaw 目录（Windows 原子保存兼容），改任何文件 150ms 后生效，不用重启
- **数据自主**：全部人设与记忆都是纯 Markdown 文本，自己 git 管理；卸载插件数据原样保留

## 安装

### web / tui / 自定义 profile（CLI）

```bash
# 把仓库克隆到本地任意位置，然后：
dsh plugin --profile web add file:<克隆目录>/dsh-claw-space
```

重启 dsh 后生效。验证：

```bash
dsh plugin --profile web list
# └── @gw/dsh-claw-space
```

### desktop profile

desktop profile 由 Electron 桌面端独占管理，请在**桌面端 UI 的插件管理页**安装本地克隆目录
`<克隆目录>/dsh-claw-space`（CLI 对 desktop 执行操作会被拒绝）。

## 目录结构（首启自动创建，只建不覆盖）

```
~/.dsh/openclaw/
├── personas/<name>/{IDENTITY,USER}.md        # 人设库存
├── .current                                   # 当前人设名指针（面板管理）
├── .soul-bindings.json                        # /user 会话绑定表（命令与面板管理，可手改）
├── IDENTITY.md / USER.md                      # 生效中的人设两件（未绑定会话的全局默认）
├── TOOLS.md / AGENTS.md                       # 恒全局
├── MEMORY.md                                  # 全局共享，仅主会话注入
├── HEARTBEAT.md                               # 有实际任务才注入
├── inject.md                                  # 自由注入块
├── .autowrite.json                            # 自动记忆配置（只存与默认不同的键，可手改）
└── memory/*.md                                # daily notes
```

## 注入总表

| 文件 | 注入方式 | order | 条件 |
|---|---|---|---|
| AGENTS.md | section `openclaw:agents` | 0 | 总是 |
| MEMORY.md | context `openclaw:memory` | 10 | 仅主会话 |
| USER.md | section `openclaw:user` | 20 | 总是（对用户的描述）；绑定会话改读库存人设（缺件留空） |
| IDENTITY.md | section `openclaw:identity` | 30 | 总是（AI 的人设）；同上 |
| TOOLS.md | section `openclaw:tools` | 40 | 总是 |
| HEARTBEAT.md | context `openclaw:heartbeat` | 50 | 非空才注入 |
| memory/*.md | context `openclaw:daily` | 80 | 最近 2 篇 |
| inject.md [system] 块 | section `gw-inject:<标题>` | 默认 40 | 块启停控制 |
| inject.md [context] 块 | context `gw-inject:<标题>` | 默认 125 | 同上 |

> 会话 cwd 下的 `AGENTS.md` 由官方 `@deepseek-ai/dsh-agent-instructions` 加载，
> 本插件读的是 `~/.dsh/openclaw/AGENTS.md`（OpenClaw 工作区协议），两处内容请勿重复。

## 配置（cordis.patch.yml 的 insert 块 config，均可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `dir` | `$DSH_HOME/openclaw` | workspace 目录 |
| `dailyNoteLimit` | 2 | 注入 daily notes 篇数 |
| `inject` | true | 注入总开关 |
| `panelEnabled` | true | 面板开关（无 webServer 自动失效） |
| `autoWrite` | 见下表 | 自动记忆启动默认值（面板与 `.autowrite.json` 可覆盖，逐项热生效） |
| `perFileLimits` | 内置默认 | 各文件注入字符上限（SOUL 4000 / IDENTITY 2000 / USER 4000 / TOOLS 4000 / AGENTS 4000 / MEMORY 6000 / daily 每篇 8000） |

`autoWrite` 子项（等价于 `.autowrite.json` 里的键，两者都是可选的）：

| 键 | 默认 | 合法区间 | 说明 |
|---|---|---|---|
| `enabled` | true | — | 自动记忆总开关 |
| `idleMs` | 60000 | 1000..3600000 | 会话空闲多久后跑一次提炼 |
| `maxTranscriptChars` | 24000 | 4000..200000 | 单次喂给子代理的转写上限（超长截尾保新） |
| `minTranscriptChars` | 200 | 0..maxTranscriptChars | 转写少于这个长度不跑 |
| `model` | `""` | ≤200 字符 | 提炼模型；空 = 跟随默认模型选择；可写 `provider/model` |
| `extractTimeoutMs` | 120000 | 10000..600000 | 提炼硬超时（创建 + 执行共用一条死线） |

```yaml
- insert:
    - id: claw-space
      name: '@gw/dsh-claw-space'
      config:
        perFileLimits:
          MEMORY.md: 8000
```

## 明确不做（YAGNI）

- 项目级 `openclaw/` 覆盖层（纯全局模式）
- slash 命令组（会话级切魂只有 `/user` 一条，其余全走面板）
- 绑定快照 / 会话级第三份人设拷贝（绑定实时读库存，文件就是真相）
- 历史备份 / diff（防手滑请对 `openclaw/` 自行 git 管理）
- 记忆检索 / embedding / 合并（文件就是真相；量级到了再评估）
- 模型可调用的人设切换工具（切全局魂只能由用户在面板操作，防模型自行换魂；`/user` 是用户手敲的命令，不是模型工具）

## 卸载

1. profile 的 `cordis.patch.yml` 删除 `claw-space` insert 块（`dsh plugin remove` 会自动处理）。
2. 数据目录 `~/.dsh/openclaw/` 按需保留或删除（你的全部人设与记忆都在这里，建议 git 管理）。

## 许可

MIT。
