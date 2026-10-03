// lib/parser.js — 自由注入块（inject.md）的纯文本解析/序列化层（零依赖）。
//
// 数据文件是纯 Markdown，人可手改、可 git 管理。块头形如：
//
//   ## [system] 群聊人格
//   描述: 群聊机器人的说话风格约束
//
//   （正文，随便写多长）
//
//   ## [context] 项目背景
//   描述:
//
//   （正文）
//
// 规则：
//   - 块头 `## [system|context] 标题`，标题必填（界面层校验，这里只负责解析）
//   - 块头后紧跟连续元数据行，第一个「非元数据且非空」的行开始算正文
//   - 元数据键大小写不敏感，也认中文别名
//   - 旧版 `kind:` 仍会被解析出来（老文件不炸），但 host 已不再使用

/** 块头正则：`## [system] 标题` / `## [context] 标题`（大小写不敏感）。 */
const HEAD_RE = /^##\s*\[\s*(system|context)\s*\]\s*(.*)$/i;

/** 元数据行正则：`键: 值`（键为标识符，值可空）。 */
const META_RE = /^([A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*)\s*[:：]\s*(.*)$/;

/** 元数据键的别名映射（统一到内部规范名）。 */
const KEY_ALIAS = new Map([
  ["order", "order"], ["排序", "order"], ["顺序", "order"],
  ["desc", "desc"], ["description", "desc"], ["描述", "desc"], ["说明", "desc"], ["备注", "desc"],
  ["trigger", "trigger"], ["触发", "trigger"], ["关键词", "trigger"],
  ["enabled", "enabled"], ["启用", "enabled"],
  ["kind", "kind"], ["类型", "kind"],
  ["pinned", "pinned"], ["钉住", "pinned"],
]);

/** 会被当作元数据（而非正文）的键。 */
const META_KEYS = new Set(["order", "desc", "trigger", "enabled", "kind", "pinned"]);

/** 排序默认值：系统提示词侧 40（紧跟官方人格段 0 之后）。 */
const DEFAULT_SYSTEM_ORDER = 40;
/** 排序默认值：运行时上下文侧 125（错开官方 110/115/120，避免同序歧义）。 */
const DEFAULT_CONTEXT_ORDER = 125;

/**
 * 判断 enabled 的真假。空值视为「真」（默认开启）。
 * @param raw - `enabled:` 后面的原始字符串。
 * @returns 是否启用。
 */
function truthy(raw) {
  if (raw === undefined || raw === null) return true;
  const s = String(raw).trim().toLowerCase();
  if (!s) return true;
  return !["false", "0", "no", "off", "否", "关", "关闭"].includes(s);
}

/**
 * 解析数据文件为块数组。
 * @param raw - 文件全文。
 * @returns 块数组 `{id, type, title, desc, order, trigger, kind, enabled, body, line}`。
 */
export function parseBlocks(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  const out = [];
  let cur = null;
  let inMeta = false;
  let bodyLines = [];

  const flush = () => {
    if (!cur) return;
    cur.body = bodyLines.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
    cur.title = cur.title.trim();
    out.push(cur);
    cur = null;
    bodyLines = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = HEAD_RE.exec(line.trim());
    if (m) {
      flush();
      cur = {
        id: "", // 由调用方按需生成（稳定 id 用 type+序号）
        type: m[1].toLowerCase(),
        title: m[2] || "",
        desc: "",
        order: null,
        trigger: "",
        kind: "",
        enabled: true,
        body: "",
        line: i + 1,
      };
      inMeta = true;
      continue;
    }
    if (!cur) continue; // 块外的内容（说明头等）忽略

    if (inMeta) {
      const trimmed = line.trim();
      if (!trimmed) continue; // 元数据区的空行忽略，不算正文开始
      const mm = META_RE.exec(trimmed);
      const key = mm ? KEY_ALIAS.get(mm[1].toLowerCase()) : undefined;
      if (mm && key && META_KEYS.has(key)) {
        const val = mm[2] || "";
        if (key === "order") {
          const n = parseInt(val, 10);
          cur.order = Number.isFinite(n) ? n : cur.order;
        } else if (key === "enabled") {
          cur.enabled = truthy(val);
        } else if (key === "pinned") {
          cur.pinned = truthy(val);
        } else {
          cur[key] = String(val).trim();
        }
        continue;
      }
      inMeta = false; // 第一个非元数据行 = 正文开始，落到下面收集
    }
    bodyLines.push(line);
  }
  flush();

  // 补默认值 + 生成稳定 id（同名同类型时追加序号，保证唯一）
  const seen = new Map();
  for (const b of out) {
    if (b.order === null || !Number.isFinite(b.order)) {
      b.order = b.type === "system" ? DEFAULT_SYSTEM_ORDER : DEFAULT_CONTEXT_ORDER;
    }
    const base = `${b.type}:${b.title || "untitled"}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    b.id = n === 1 ? base : `${base}#${n}`;
  }
  return out;
}

/**
 * 把块数组序列化回数据文件文本。
 * @param blocks - 块数组。
 * @returns 文件全文（带说明头）。
 */
export function serializeBlocks(blocks) {
  const head = [
    "# @gw/dsh-claw-space — 文字注入配置（inject.md）",
    "#",
    "# 块头写法：## [system] 标题   或   ## [context] 标题",
    "# 可选元数据行（写在块头下方，正文之前）：",
    "#   描述: 一句话说明（只有你看，不进提示词）",
    "#   排序: 数字，决定拼在提示词里的位置；系统侧默认 40，上下文侧默认 125",
    "#   启用: false 可临时停用这个块",
    "#",
    "# 这个文件由设置页「OpenClaw 工作区 → 文字注入」维护，也可以直接手改（保存即热加载）。",
    "",
  ].join("\n");

  const parts = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b || (b.type !== "system" && b.type !== "context")) continue;
    const type = b.type;
    const title = String(b.title || "").trim() || "未命名";
    const meta = [];
    if (String(b.desc || "").trim()) meta.push(`描述: ${String(b.desc).trim()}`);
    if (Number.isFinite(b.order)) {
      const dflt = type === "system" ? DEFAULT_SYSTEM_ORDER : DEFAULT_CONTEXT_ORDER;
      if (b.order !== dflt) meta.push(`排序: ${b.order}`);
    }
    if (b.enabled === false) meta.push("启用: false");
    const body = String(b.body || "").replace(/\s+$/, "");
    parts.push(
      [`## [${type}] ${title}`, ...meta, "", body].join("\n")
    );
  }
  return head + (parts.length ? parts.join("\n\n") + "\n" : "");
}

export { DEFAULT_SYSTEM_ORDER, DEFAULT_CONTEXT_ORDER };
