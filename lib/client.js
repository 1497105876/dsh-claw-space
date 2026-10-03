// lib/client.js — @gw/dsh-claw-space 浏览器半（client plugin bundle）。
//
// lazy-CJS bundle：window.__ModuleLoader__.load
// 经 dsh-client-modules 加载，factory 体是 plain CJS，react 来自平台基础。
// 往官方设置页左侧栏注册「OpenClaw 工作区」分区（settings.section slot）。
// 数据经 host 半 webServer 路由 /claw-space/* 读写（同源 fetch，无 CORS）。
//
// 四区块：
//   1. 人设管理：当前人设 + 库存卡片 + 切换/保存/新建/删除（删除前端二次确认）
//   2. 文件浏览：文件列表 + 查看/编辑/保存（personas/ 下只读）
//   3. 文字注入：inject.md 块卡片（增删改/启停/排序），无历史备份（D7）
//   4. 注入预览：sp.assemble() 全局 + 活跃 agent，本插件段高亮

window.__ModuleLoader__.load({
  id: "@gw/dsh-claw-space",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = null;
    try { React = require("react") || null; } catch (e) { React = null; }

    var NS = "@gw/dsh-claw-space";
    var API = "/claw-space";

    // ───────────────────────── 词典 ─────────────────────────
    var UI_zh = {
      nav: "OpenClaw 工作区",
      title: "OpenClaw 工作区",
      blurb: "~/.dsh/openclaw/ 常驻文件族跨会话注入 + 人设切换 + 文字注入。文件改动下一轮生效，不用重启。",

      tabPersona: "人设",
      tabFiles: "文件",
      tabInject: "文字注入",
      tabPreview: "注入预览",

      // 人设
      personaCurrent: "当前人设",
      personaNone: "未命名",
      personaStock: "人设库存",
      personaEmpty: "库存为空。点「新建人设」创建一个（可勾选从当前拷贝）。",
      personaSwitch: "切换",
      personaClear: "清除当前",
      personaClearHint: "清除指针后回到「未命名默认」：全局默认 = 根目录文件本身，与任何库存解绑，直接编辑根目录即可。",
      personaClearConfirm: "清除当前人设指针？根目录文件内容不会被改动，之后可直接编辑根目录作为默认人设。",
      injectionToggle: "注入总开关",
      injectionToggleHint: "workspace 文件族的注入总闸：关闭后 IDENTITY / USER / TOOLS / AGENTS / MEMORY / 每日日志 / HEARTBEAT 全部停止注入（自由注入块不受影响，它们有自己的块级启停），面板编辑不受影响；勾上恢复。",
      personaNew: "新建人设",
      personaNewFromCurrent: "从当前拷贝",
      personaCancel: "取消",
      personaDelete: "删除",
      personaDeleteCurHint: "当前生效中；先切换到其他人设再删除",
      personaNewPrompt: "新人设名（英文/数字/中文均可，禁路径符号）：",
      personaDeleteConfirm: "确定删除人设「{n}」？此操作不可撤销。",
      personaCurrentBadge: "生效中",
      personaHint: "切换只影响 IDENTITY / USER 两件（进系统提示词）；MEMORY 与 TOOLS/AGENTS 恒全局。",
      personaGuardDirty: "文件区有未保存的改动，切换人设将丢弃这些改动。确定继续？",

      // 会话绑定（多魂 /user + 面板只读展示）
      bindTitle: "会话绑定",
      bindHint: "在对话里用 /user <人设名> 绑定本会话、/user off 解绑（面板不提供切换入口）；子代理随父会话。绑定的 IDENTITY / USER 实时读库存（缺件留空）。",
      bindEmpty: "没有会话绑定。",
      bindUnbind: "解绑",
      bindClear: "清空全部",
      bindClearConfirm: "确定清空全部会话绑定？解绑的会话将回到全局默认人设。",

      // 文件
      filesRoot: "生效文件（根目录，注入中的就是这些）",
      filesEmpty: "workspace 里还没有文件。",
      filePick: "选个文件看看",
      fileSave: "保存",
      fileSaved: "已保存，下一轮生效",
      fileLoaded: "已加载",
      stockEditable: "库存文件可直接编辑：绑定此库存的会话即时生效；未绑定会话读根目录默认，不受影响。",
      fileDirty: "有未保存改动",
      fileLoading: "读取中…",

      // 注入
      injNewSys: "新增系统块",
      injNewCtx: "新增上下文块",
      injExpand: "展开",
      injCollapse: "收起",
      injSave: "保存全部",
      injSaved: "已保存，下一轮生效",
      injDirty: "有未保存的改动",
      injEmpty: "还没有注入块。点「新增块」创建。",
      injTitlePh: "块标题（必填）",
      injBodyPh: "要注入的内容…",
      injDescPh: "描述（可选，只有你看得到）",
      injTypeSys: "系统",
      injTypeCtx: "上下文",
      injDeleteConfirm: "确定删除这个块？",
      injOrder: "排序",

      // 预览
      pvRefresh: "刷新装配",
      pvLoading: "正在装配…",
      pvGlobal: "全局",
      pvSys: "系统提示词",
      pvCtx: "运行时上下文",
      pvEmpty: "（空）",
      pvError: "装配失败",
      pvHint: "下一轮请求实际会用到的装配结果；全部注册段全量列出，本插件段显示文件原文。",
      pvShare: "我的占比",
      pvSegCount: "{n} 段",
      pvMine: "本插件",
      pvOfficial: "官方",
      pvClickHint: "点击任意段落可展开查看注入的真实内容。",
      pvMemoryNote: "MEMORY.md 仅主会话注入：预览是全局装配（无会话上下文），这里显示为空属正常。",

      saved: "已保存",
      failed: "失败：",
      loadFailed: "读取数据失败",
      confirmOn: "确定",
    };

    var UI_en = {
      nav: "OpenClaw Workspace",
      title: "OpenClaw Workspace",
      blurb: "Persistent OpenClaw-style files injected into every session, with persona switching and free-form text blocks.",
      tabPersona: "Persona", tabFiles: "Files", tabInject: "Text Inject", tabPreview: "Preview",
      personaCurrent: "Current persona", personaNone: "unnamed", personaStock: "Stock",
      personaEmpty: "No stock personas yet.", personaSwitch: "Switch",
      personaNew: "New persona", personaNewFromCurrent: "Copy from current", personaCancel: "Cancel",
      personaClear: "Clear current", personaClearHint: "After clearing the pointer you return to the unnamed default: the global default IS the root files, detached from any stock entry — just edit the root files directly.", personaClearConfirm: "Clear the current persona pointer? Root files keep their content; you can then edit them directly as the default persona.", personaDelete: "Delete", personaCurrentBadge: "active",
      personaDeleteCurHint: "Active; switch to another persona before deleting",
      personaHint: "Switching only affects IDENTITY / USER (injected into the system prompt); MEMORY and TOOLS/AGENTS stay global.",
      personaGuardDirty: "Files view has unsaved changes; switching personas will discard them. Continue?",
      bindTitle: "Session bindings",
      bindHint: "Inside a session run /user <name> to bind it, /user off to unbind (the panel offers no switching); sub-agents follow their parent. Bound IDENTITY / USER are read live from stock (missing files stay empty).",
      bindEmpty: "No session bindings.",
      bindUnbind: "Unbind",
      bindClear: "Clear all",
      bindClearConfirm: "Clear all session bindings? Unbound sessions fall back to the global default persona.",
      filesRoot: "Active files (workspace root)",
      filesEmpty: "No files yet.", filePick: "Pick a file", fileSave: "Save", fileSaved: "Saved, applies next turn",
      fileLoaded: "Loaded",
      stockEditable: "Stock files are editable directly: sessions bound to this stock see changes instantly; unbound sessions read the root default and are unaffected.", fileDirty: "Unsaved changes", fileLoading: "Loading…",
      injNewSys: "New system block", injNewCtx: "New context block", injExpand: "Expand", injCollapse: "Collapse", injSave: "Save all", injSaved: "Saved, applies next turn", injDirty: "Unsaved changes",
      injEmpty: "No blocks yet.", injTitlePh: "Title (required)", injBodyPh: "Content to inject…",
      injDescPh: "Description (optional)", injTypeSys: "System", injTypeCtx: "Context",
      injDeleteConfirm: "Delete this block?", injOrder: "Order",
      pvRefresh: "Refresh assembly", pvLoading: "Assembling…", pvGlobal: "Global",
      pvSys: "System prompt", pvCtx: "Runtime context", pvMine: "mine", pvOfficial: "official",
      pvEmpty: "(empty)", pvError: "Assembly failed",       pvHint: "What the next request will actually use; every registered segment is listed in full, mine shown as file source.",
      pvShare: "My share",
      pvSegCount: "{n} segments",
      pvMine: "Mine",
      pvOfficial: "Official",
      pvClickHint: "Click any segment to expand and inspect its real content.",
      pvMemoryNote: "MEMORY.md is main-session only: the preview is a global assembly (no session context), so empty here is expected.",
      saved: "Saved", failed: "Failed: ", loadFailed: "Failed to load", confirmOn: "OK",
    };

    function makeT(lang) {
      var dict = lang === "en" ? UI_en : UI_zh;
      return function (k, vars) {
        var s = dict[k] != null ? dict[k] : (UI_zh[k] != null ? UI_zh[k] : k);
        if (vars) for (var v in vars) s = s.split("{" + v + "}").join(vars[v]);
        return s;
      };
    }

    // ───────────────────────── 工具 ─────────────────────────
    var h = React.createElement;

    function api(method, path, body) {
      return fetch(API + path, {
        method: method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }).then(function (r) {
        return r.json().then(function (j) {
          if (!r.ok || (j && j.error)) throw new Error(j && j.error ? j.error : "HTTP " + r.status);
          return j;
        });
      });
    }

    function ocw_cls(name) { return "ocw-" + name; }

    // ───────────────────────── 样式 ─────────────────────────
    var CSS = ""
      + "." + ocw_cls("root") + "{display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-fg-1,#333)}"
      + "." + ocw_cls("hd") + "-t{font-size:15px;font-weight:600}"
      + "." + ocw_cls("hd") + "-s{font-size:12px;opacity:.65;margin-top:2px}"
      + "." + ocw_cls("tabs") + "{display:flex;gap:6px;flex-wrap:wrap}"
      + "." + ocw_cls("tab") + "{border:1px solid var(--dsw-alias-border-1,#ddd);background:transparent;border-radius:18px;height:28px;padding:0 14px;font-size:12px;cursor:pointer}"
      + "." + ocw_cls("tab") + "[data-on='1']{background:var(--dsw-alias-bg-active,#eef);font-weight:600}"
      + "." + ocw_cls("card") + "{border:1px solid var(--dsw-alias-border-1,#e3e3e3);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-1,#fff)}"
      + "." + ocw_cls("row") + "{display:flex;gap:8px;align-items:center;flex-wrap:wrap}"
      + "." + ocw_cls("btn") + "{border:1px solid var(--dsw-alias-border-1,#ddd);border-radius:18px;height:28px;padding:0 14px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-1,#fff)}"
      + "." + ocw_cls("btn") + "[data-primary='1']{background:var(--dsw-alias-bg-active,#eef);font-weight:600}"
      + "." + ocw_cls("btn") + "[data-danger='1']{color:#c0392b;border-color:#e6b0aa}"
      + "." + ocw_cls("btn") + ":disabled{opacity:.45;cursor:default}"
      + "." + ocw_cls("badge") + "{display:inline-block;border-radius:10px;padding:1px 8px;font-size:11px;background:var(--dsw-alias-bg-active,#eef)}"
      + "." + ocw_cls("badge") + "[data-mute='1']{opacity:.5}"
      + "." + ocw_cls("input") + "{height:32px;border:1px solid var(--dsw-alias-border-1,#ddd);border-radius:8px;padding:0 10px;font-size:13px;background:var(--dsw-alias-bg-1,#fff);color:inherit}"
      + "." + ocw_cls("area") + "{width:100%;min-height:140px;border:1px solid var(--dsw-alias-border-1,#ddd);border-radius:8px;padding:8px 10px;font-size:13px;font-family:ui-monospace,Consolas,monospace;line-height:1.5;background:var(--dsw-alias-bg-1,#fff);color:inherit;box-sizing:border-box;resize:vertical}"
      + "." + ocw_cls("list") + "{display:flex;flex-direction:column;gap:8px}"
      + "." + ocw_cls("filelist") + "{display:flex;flex-wrap:wrap;gap:6px}"
      + "." + ocw_cls("fileitem") + "{border:1px solid var(--dsw-alias-border-1,#ddd);border-radius:8px;height:26px;padding:0 10px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-1,#fff);color:inherit;display:inline-flex;align-items:center}"
      + "." + ocw_cls("fileitem") + "[data-on='1']{background:var(--dsw-alias-bg-active,#eef);font-weight:600}"
      + "." + ocw_cls("muted") + "{font-size:12px;opacity:.6}"
      + "." + ocw_cls("toast") + "{font-size:12px;border-radius:8px;padding:4px 10px;background:var(--dsw-alias-bg-active,#eef);align-self:flex-start}"
      + "." + ocw_cls("err") + "{font-size:12px;color:#c0392b}"
      + "." + ocw_cls("seg") + "{display:flex;gap:4px;flex-wrap:wrap;align-items:center;font-size:12px}"
      + "." + ocw_cls("pvseg") + "{border:1px solid var(--dsw-alias-border-1,#eee);border-radius:8px;padding:6px 8px}"
      + "." + ocw_cls("pvseg") + "[data-mine='1']{border-color:var(--dsw-alias-border-active,#88f)}";

    // ───────────────────────── 组件 ─────────────────────────
    function Toast(props) {
      if (!props.msg) return null;
      var cls = props.err ? ocw_cls("toast") + " " + ocw_cls("err") : ocw_cls("toast");
      return h("div", { className: cls }, props.msg);
    }

    // 1) 人设区
    function PersonaView(props) {
      var t = props.t;
      var ws = props.workspace || {};
      var current = ws.current || "";
      var personas = ws.personas || [];
      var bindings = ws.bindings || {};
      var bindSids = Object.keys(bindings).sort();
      var busy = props.busy;
      // 新建人设的内联输入（Electron 不支持 window.prompt，弹窗式输入点不开）
      var newS = React.useState(null);
      var newName = newS[0], setNewName = newS[1];
      var fcs = React.useState(true);
      var newFromCurrent = fcs[0], setNewFromCurrent = fcs[1];

      function submitNew() {
        var name = (newName || "").trim();
        if (!name) return;
        setNewName(null);
        act(function () { return api("POST", "/persona/new", { name: name, fromCurrent: newFromCurrent }); });
      }

      function act(fn, okMsg) {
        props.setBusy(true);
        fn().then(function (j) {
          if (j && j.ok === false) {
            props.toast(t("failed") + (j.error || "未知错误"), true);
            return;
          }
          var extra = j && j.warnings && j.warnings.length ? "（" + j.warnings.join("；") + "）" : "";
          props.toast((okMsg || t("saved")) + extra, !!extra);
          if (props.onPersonaChanged) props.onPersonaChanged(); // 人设三件套可能被改写，文件编辑态作废
          props.refresh(j);
        }).catch(function (e) {
          props.toast(t("failed") + e.message, true);
        }).finally(function () { props.setBusy(false); });
      }

      return h("div", { className: ocw_cls("list") },
        h("div", { className: ocw_cls("card") },
          h("div", { className: ocw_cls("row") },
            h("span", { className: ocw_cls("muted") }, t("personaCurrent")),
            h("span", { className: ocw_cls("badge") }, current || t("personaNone")),
            h("div", { style: { flex: 1 } }),
            h("label", { className: ocw_cls("seg"), style: { cursor: "pointer" }, title: t("injectionToggleHint") },
              h("input", {
                type: "checkbox",
                checked: ws.settings ? ws.settings.injectionEnabled !== false : true,
                disabled: busy,
                onChange: function (e) {
                  act(function () { return api("POST", "/injection/enabled", { value: e.target.checked }); });
                },
              }),
              h("span", null, t("injectionToggle"))
            ),
            h("button", {
              className: ocw_cls("btn"), disabled: busy || !current,
              title: t("personaClearHint"),
              onClick: function () {
                if (!window.confirm(t("personaClearConfirm"))) return;
                act(function () { return api("POST", "/persona/clear"); }, t("saved"));
              },
            }, t("personaClear")),
            h("button", {
              className: ocw_cls("btn"), disabled: busy,
              onClick: function () { setNewName(""); },
            }, t("personaNew"))
          ),
          h("div", { className: ocw_cls("muted") }, t("personaHint")),
          h("div", { className: ocw_cls("muted") }, t("personaToggleHint")),
          newName !== null ? h("div", { className: ocw_cls("row") },
            h("input", {
              className: ocw_cls("input"), style: { flex: 1, minWidth: "200px" },
              autoFocus: true, placeholder: t("personaNewPrompt"),
              value: newName,
              onChange: function (e) { setNewName(e.target.value); },
              onKeyDown: function (e) {
                if (e.key === "Enter") submitNew();
                else if (e.key === "Escape") setNewName(null);
              },
            }),
            h("label", { className: ocw_cls("seg"), style: { cursor: "pointer" } },
              h("input", {
                type: "checkbox", checked: newFromCurrent,
                onChange: function (e) { setNewFromCurrent(e.target.checked); },
              }),
              h("span", null, t("personaNewFromCurrent"))),
            h("button", {
              className: ocw_cls("btn"), "data-primary": "1", disabled: busy || !newName.trim(),
              onClick: submitNew,
            }, t("confirmOn")),
            h("button", {
              className: ocw_cls("btn"), disabled: busy,
              onClick: function () { setNewName(null); },
            }, t("personaCancel"))
          ) : null
        ),
        h("div", { className: ocw_cls("card") },
          h("div", { className: ocw_cls("muted") }, t("personaStock")),
          personas.length === 0
            ? h("div", { className: ocw_cls("muted") }, t("personaEmpty"))
            : h("div", { className: ocw_cls("list") },
                personas.map(function (name) {
                  var isCur = name === current;
                  return h("div", { key: name, className: ocw_cls("row") },
                    h("span", { className: ocw_cls("badge"), "data-mute": isCur ? "0" : "1" },
                      isCur ? t("personaCurrentBadge") : name),
                    h("span", { style: { fontWeight: isCur ? 600 : 400 } }, name),
                    h("div", { style: { flex: 1 } }),
                    !isCur ? h("button", {
                      className: ocw_cls("btn"), "data-primary": "1", disabled: busy,
                      title: t("personaHint"),
                      onClick: function () {
                        if (props.onGuardSwitch && !props.onGuardSwitch()) return;
                        act(function () { return api("POST", "/persona/switch", { name: name }); }, t("saved"));
                      },
                    }, t("personaSwitch")) : null,
                    h("button", {
                      className: ocw_cls("btn"), "data-danger": "1",
                      disabled: isCur || busy,
                      title: isCur ? t("personaDeleteCurHint") : undefined,
                      onClick: function () {
                        if (!window.confirm(t("personaDeleteConfirm", { n: name }))) return;
                        act(function () { return api("POST", "/persona/delete", { name: name }); });
                      },
                    }, t("personaDelete"))
                  );
                })
              )
        ),
        h("div", { className: ocw_cls("card") },
          h("div", { className: ocw_cls("row") },
            h("div", { className: ocw_cls("muted") }, t("bindTitle")),
            h("span", { className: ocw_cls("badge"), "data-mute": "1" }, "/user"),
            h("div", { style: { flex: 1 } }),
            bindSids.length ? h("button", {
              className: ocw_cls("btn"), "data-danger": "1", disabled: busy,
              onClick: function () {
                if (!window.confirm(t("bindClearConfirm"))) return;
                act(function () { return api("POST", "/binding/clear"); });
              },
            }, t("bindClear")) : null
          ),
          h("div", { className: ocw_cls("muted") }, t("bindHint")),
          bindSids.length === 0
            ? h("div", { className: ocw_cls("muted") }, t("bindEmpty"))
            : h("div", { className: ocw_cls("list") },
                bindSids.map(function (sid) {
                  return h("div", { key: sid, className: ocw_cls("row") },
                    h("span", { className: ocw_cls("badge"), title: sid },
                      sid.length > 14 ? sid.slice(0, 14) + "…" : sid),
                    h("span", { className: ocw_cls("muted") }, "→"),
                    h("span", { style: { fontWeight: 600 } }, bindings[sid]),
                    h("div", { style: { flex: 1 } }),
                    h("button", {
                      className: ocw_cls("btn"), disabled: busy,
                      onClick: function () {
                        act(function () { return api("POST", "/binding/unbind", { sessionId: sid }); });
                      },
                    }, t("bindUnbind"))
                  );
                }))
        )
      );
    }

    // 2) 文件区
    function FilesView(props) {
      var t = props.t;
      var ws = props.workspace || {};
      var all = (props.files || []).filter(function (f) { return !f.dir; });
      // 分组：根目录生效文件一组，库存按人设各一组（拍板 2026-10-03：按人设分组，不再平铺路径）
      var rootFiles = all.filter(function (f) { return f.path.indexOf("/") === -1; });
      var stockMap = {};
      all.forEach(function (f) {
        if (f.path.indexOf("personas/") === 0) {
          var parts = f.path.split("/");
          var name = parts[1] || "";
          (stockMap[name] = stockMap[name] || []).push({
            path: f.path,
            label: parts.slice(2).join("/") || f.path,
          });
        }
      });
      // 人设顺序以库存列表为准，文件树里多出的目录兜底追加
      var stockNames = (ws.personas || []).slice();
      Object.keys(stockMap).forEach(function (n) {
        if (stockNames.indexOf(n) === -1) stockNames.push(n);
      });
      var st = props.state || {};
      var rel = st.selected || "";
      var isStock = rel.indexOf("personas/") === 0;
      // 当前编辑文件若是根目录注入项，展示注入字数 / 上限（库存文件是另一个人设的
      // 来源，字符统计会误导，不显示）
      var injInfo = null;
      if (rel && rel.indexOf("/") === -1) {
        var m = (ws.files || []).find(function (x) { return x.file === rel; });
        if (m) injInfo = m.chars + " / " + (m.limit || "∞") + " ch" + (m.mainOnly ? " · 仅主会话" : "");
      }
      var lastLoad = ws.lastLoadAt ? new Date(ws.lastLoadAt).toLocaleString() : "";

      function pick(p) {
        // loading 用显式标志；成功失败都必须有可见反馈（上一版 pick 定义丢失导致点击无反应）
        props.setFileState({ selected: p, raw: null, loading: true, dirty: false });
        api("GET", "/file?path=" + encodeURIComponent(p)).then(function (j) {
          props.setFileState({ selected: p, raw: j.raw == null ? "" : j.raw, loading: false, dirty: false });
          props.toast(t("fileLoaded") + " " + p);
        }).catch(function (e) {
          props.setFileState({ selected: p, raw: "", loading: false, dirty: false });
          props.toast(t("failed") + e.message, true);
        });
      }
      function save() {
        api("POST", "/file/save", { path: rel, content: st.raw || "" }).then(function () {
          props.setFileState({ selected: rel, raw: st.raw, loading: false, dirty: false });
          props.toast(t("fileSaved"));
          props.refresh();
        }).catch(function (e) { props.toast(t("failed") + e.message, true); });
      }

      function fileBtn(f, label) {
        return h("button", {
          key: f.path, className: ocw_cls("fileitem"), "data-on": rel === f.path ? "1" : "0",
          title: f.path,
          onClick: function () { pick(f.path); },
        }, label || f.path);
      }

      return h("div", { className: ocw_cls("list") },
        h("div", { className: ocw_cls("muted") }, lastLoad ? "最后加载 " + lastLoad : ""),
        all.length === 0
          ? h("div", { className: ocw_cls("muted") }, t("filesEmpty"))
          : h("div", { className: ocw_cls("list") },
              h("div", { className: ocw_cls("muted") }, t("filesRoot")),
              h("div", { className: ocw_cls("filelist") }, rootFiles.map(function (f) { return fileBtn(f); })),
              stockNames.map(function (name) {
                var files = stockMap[name] || [];
                if (!files.length) return null;
                return h("div", { key: name, className: ocw_cls("list"), style: { marginTop: "4px" } },
                  h("div", { className: ocw_cls("muted") }, "personas/" + name),
                  h("div", { className: ocw_cls("filelist") },
                    files.map(function (f) { return fileBtn(f, f.label); })));
              })),
        !rel ? h("div", { className: ocw_cls("muted") }, t("filePick")) : null,
        rel && st.loading ? h("div", { className: ocw_cls("muted") }, t("fileLoading")) : null,
        rel && !st.loading
          ? h("div", { className: ocw_cls("card") },
              h("div", { className: ocw_cls("row") },
                h("span", { className: ocw_cls("badge") }, rel),
                injInfo ? h("span", { className: ocw_cls("muted") }, injInfo) : null,
                st.dirty ? h("span", { className: ocw_cls("err") }, t("fileDirty")) : null,
                h("div", { style: { flex: 1 } }),
                isStock ? h("span", { className: ocw_cls("muted") }, t("stockEditable")) : null,
                h("button", { className: ocw_cls("btn"), "data-primary": "1", disabled: !st.dirty, onClick: save }, t("fileSave"))
              ),
              h("textarea", {
                className: ocw_cls("area"),
                value: st.raw == null ? "" : st.raw,
                onChange: function (e) { props.setFileState({ selected: rel, raw: e.target.value, loading: false, dirty: true }); },
              }))
          : null
      );
    }

    // 3) 文字注入区
    function InjectView(props) {
      var t = props.t;
      var blocks = props.blocks || [];
      var dirty = props.injDirty;
      // 折叠状态（展开/收起交互）：默认收起，只显示标题行；新增块自动展开
      var expS = React.useState({});
      var expanded = expS[0], setExpanded = expS[1];

      function setBlocks(nb, opts) {
        props.setBlocks(nb, true);
        if (opts && opts.expandLast) {
          var e2 = Object.assign({}, expanded);
          e2[nb.length - 1] = true;
          setExpanded(e2);
        }
      }

      return h("div", { className: ocw_cls("list") },
        h("div", { className: ocw_cls("row") },
          h("button", {
            className: ocw_cls("btn"),
            onClick: function () {
              setBlocks(blocks.concat([{ type: "system", title: "", desc: "", order: null, enabled: true, body: "" }]), { expandLast: true });
            },
          }, t("injNewSys")),
          h("button", {
            className: ocw_cls("btn"),
            onClick: function () {
              setBlocks(blocks.concat([{ type: "context", title: "", desc: "", order: null, enabled: true, body: "" }]), { expandLast: true });
            },
          }, t("injNewCtx")),
          h("div", { style: { flex: 1 } }),
          dirty ? h("span", { className: ocw_cls("err") }, t("injDirty")) : null,
          h("button", {
            className: ocw_cls("btn"), "data-primary": "1", disabled: !dirty,
            onClick: function () {
              props.setBusy(true);
              api("POST", "/inject/save", { blocks: blocks }).then(function () {
                props.setBlocks(blocks, false);
                props.toast(t("injSaved"));
              }).catch(function (e) { props.toast(t("failed") + e.message, true); })
                .finally(function () { props.setBusy(false); });
            },
          }, t("injSave"))
        ),
        blocks.length === 0 ? h("div", { className: ocw_cls("muted") }, t("injEmpty")) : null,
        blocks.map(function (b, i) {
          function patch(p) {
            var nb = blocks.slice();
            nb[i] = Object.assign({}, b, p);
            setBlocks(nb);
          }
          var open = !!expanded[i];
          return h("div", { key: i, className: ocw_cls("card") },
            h("div", { className: ocw_cls("row") },
              h("span", { className: ocw_cls("badge"), "data-mute": b.enabled ? "0" : "1" },
                b.type === "system" ? t("injTypeSys") : t("injTypeCtx")),
              h("input", {
                className: ocw_cls("input"), style: { flex: 1 }, value: b.title || "",
                placeholder: t("injTitlePh"),
                onChange: function (e) { patch({ title: e.target.value }); },
              }),
              h("label", { className: ocw_cls("seg") },
                h("input", { type: "checkbox", checked: !!b.enabled, onChange: function (e) { patch({ enabled: e.target.checked }); } }),
                h("span", null, "on")
              ),
              h("button", {
                className: ocw_cls("btn"), disabled: open,
                onClick: function () { var e2 = Object.assign({}, expanded); e2[i] = true; setExpanded(e2); },
              }, t("injExpand")),
              h("button", {
                className: ocw_cls("btn"), disabled: !open,
                onClick: function () { var e2 = Object.assign({}, expanded); e2[i] = false; setExpanded(e2); },
              }, t("injCollapse")),
              h("button", {
                className: ocw_cls("btn"), "data-danger": "1",
                onClick: function () {
                  if (!window.confirm(t("injDeleteConfirm"))) return;
                  var nb = blocks.slice(); nb.splice(i, 1); setBlocks(nb);
                },
              }, "×")
            ),
            open ? h("div", { className: ocw_cls("row") },
              h("input", {
                className: ocw_cls("input"), style: { width: 90 }, type: "number",
                value: b.order == null ? "" : b.order,
                placeholder: b.type === "system" ? "40" : "125",
                title: t("injOrder"),
                onChange: function (e) { patch({ order: e.target.value === "" ? null : Number(e.target.value) }); },
              }),
              h("input", {
                className: ocw_cls("input"), style: { flex: 1 }, value: b.desc || "",
                placeholder: t("injDescPh"),
                onChange: function (e) { patch({ desc: e.target.value }); },
              })
            ) : null,
            open ? h("textarea", {
              className: ocw_cls("area"), value: b.body || "", placeholder: t("injBodyPh"),
              onChange: function (e) { patch({ body: e.target.value }); },
            }) : null
          );
        })
      );
    }

    // 4) 注入预览区
    function PreviewView(props) {
      var t = props.t;
      var pv = props.pv || null;
      var loading = props.pvLoading;
      // 段落展开状态：key = kind:index，点击展开查看注入的真实内容
      var expS = React.useState({});
      var expanded = expS[0], setExpanded = expS[1];
      // 分组折叠状态（拍板 2026-10-03：系统提示词/运行时上下文标题可折叠）：默认展开
      var grpS = React.useState({});
      var groups = grpS[0], setGroups = grpS[1];

      function grpOpen(k) { return groups[k] === undefined ? true : groups[k]; }
      function toggleGroup(k) {
        var e2 = Object.assign({}, groups);
        e2[k] = !grpOpen(k);
        setGroups(e2);
      }
      function groupHeader(k, labelKey, totalChars, count) {
        var open = grpOpen(k);
        return h("div", {
          className: ocw_cls("seg"), style: { cursor: "pointer", userSelect: "none" },
          title: open ? t("injCollapse") : t("injExpand"),
          onClick: function () { toggleGroup(k); },
        },
          h("span", { className: ocw_cls("badge") }, t(labelKey)),
          h("span", { className: ocw_cls("muted") },
            totalChars + " ch · " + t("pvSegCount", { n: count })),
          h("div", { style: { flex: 1 } }),
          h("span", { className: ocw_cls("muted") }, open ? "▾" : "▸"));
      }

      function segList(sections, kind) {
        return h("div", { className: ocw_cls("list") },
          (sections || []).map(function (s, i) {
            var k = kind + ":" + i;
            var open = !!expanded[k];
            return h("div", {
              key: k, className: ocw_cls("pvseg"), "data-mine": s.mine ? "1" : "0",
              style: { cursor: s.chars > 0 ? "pointer" : "default" },
              onClick: function () { if (s.chars > 0) { var e2 = Object.assign({}, expanded); e2[k] = !e2[k]; setExpanded(e2); } },
            },
              h("div", { className: ocw_cls("seg") },
                h("span", { className: ocw_cls("badge"), "data-mute": s.mine ? "0" : "1" }, s.mine ? t("pvMine") : t("pvOfficial")),
                h("span", { style: { fontWeight: s.mine ? 600 : 400 } }, s.name),
                h("span", { className: ocw_cls("muted") }, s.chars === 0 ? t("pvEmpty") : s.chars + " ch"),
                h("div", { style: { flex: 1 } }),
                s.chars > 0 ? h("span", { className: ocw_cls("muted") }, open ? "▾" : "▸") : null
              ),
              open ? h("pre", {
                style: { maxHeight: "260px", overflow: "auto", whiteSpace: "pre-wrap", margin: "6px 0 0", fontSize: "12px", lineHeight: 1.5 },
              }, s.text || "") : null
            );
          })
        );
      }

      function shareLine(pvScope) {
        if (!pvScope || !pvScope.totals || !pvScope.totals.allChars) return null;
        var tt = pvScope.totals;
        var pct = Math.round((tt.mineChars / tt.allChars) * 100);
        return h("div", { className: ocw_cls("seg") },
          h("span", { className: ocw_cls("badge") }, t("pvShare")),
          h("span", { className: ocw_cls("muted") },
            tt.mineChars + " / " + tt.allChars + " ch（" + pct + "%）")
        );
      }

      function block(pvScope) {
        if (!pvScope) return null;
        return h("div", { className: ocw_cls("list") },
          shareLine(pvScope),
          groupHeader("sys", "pvSys", pvScope.system.totalChars, (pvScope.system.sections || []).length),
          grpOpen("sys") ? segList(pvScope.system.sections, "sys") : null,
          groupHeader("ctx", "pvCtx", pvScope.context.totalChars, (pvScope.context.sections || []).length),
          grpOpen("ctx") ? segList(pvScope.context.sections, "ctx") : null
        );
      }

      var scoped = null; // 会话作用域预览已整体移除：「会话」不在预览中出现
      return h("div", { className: ocw_cls("list") },
        h("div", { className: ocw_cls("row") },
          h("button", { className: ocw_cls("btn"), "data-primary": "1", disabled: loading, onClick: props.loadPreview }, t("pvRefresh")),
          h("span", { className: ocw_cls("muted") }, t("pvHint"))
        ),
        h("div", { className: ocw_cls("muted") }, t("pvMemoryNote")),
        loading ? h("div", { className: ocw_cls("muted") }, t("pvLoading")) : null,
        pv && pv.errors && pv.errors.length
          ? h("div", { className: ocw_cls("err") }, pv.errors.join("; "))
          : null,
        pv && !loading ? block(pv.global) : null
      );
    }

    // ───────────────────────── 主视图 ─────────────────────────
    function View() {
      var t = makeT();
      var state = React.useState(null);
      var data = state[0], setData = state[1];
      var tabS = React.useState("persona");
      var tab = tabS[0], setTab = tabS[1];
      var toastS = React.useState(null);
      var toast = toastS[0], setToast = toastS[1];
      var busyS = React.useState(false);
      var busy = busyS[0], setBusy = busyS[1];
      var fileS = React.useState({ selected: "", raw: null, dirty: false });
      var fileSt = fileS[0], setFileSt = fileS[1];
      var injS = React.useState({ blocks: null, dirty: false });
      var injSt = injS[0], setInjSt = injS[1];
      var pvS = React.useState({ pv: null, loading: false });
      var pvSt = pvS[0], setPvSt = pvS[1];

      function toastMsg(msg, err) {
        setToast(err ? { msg: msg, err: true } : { msg: msg });
        setTimeout(function () { setToast(null); }, 2500);
      }

      function refresh(j) {
        if (j && j.workspace && j.inject) {
          setData(j);
          setInjSt({ blocks: j.inject.blocks, dirty: false });
        } else {
          api("GET", "/state").then(function (d) {
            setData(d);
            setInjSt({ blocks: d.inject.blocks, dirty: false });
          }).catch(function (e) { toastMsg(t("loadFailed") + " " + e.message, true); });
        }
      }

      React.useEffect(function () {
        refresh();
        // 注入一次样式
        var id = "ocw-panel-style";
        if (!document.getElementById(id)) {
          var el = document.createElement("style");
          el.id = id;
          el.textContent = CSS;
          document.head.appendChild(el);
        }
      }, []);

      function loadPreview() {
        setPvSt({ pv: pvSt.pv, loading: true });
        api("POST", "/preview").then(function (j) {
          setPvSt({ pv: j, loading: false });
        }).catch(function (e) {
          setPvSt({ pv: null, loading: false });
          toastMsg(t("failed") + e.message, true);
        });
      }

      React.useEffect(function () {
        if (tab === "preview" && !pvSt.pv && !pvSt.loading) loadPreview();
      }, [tab]);

      if (!data) return h("div", { className: ocw_cls("root") }, h("div", { className: ocw_cls("muted") }, "…"));

      var body = null;
      if (tab === "persona") {
        body = h(PersonaView, {
          t: t, workspace: data.workspace, busy: busy, setBusy: setBusy,
          refresh: refresh, toast: toastMsg,
          onPersonaChanged: function () { setFileSt({ selected: "", raw: null, dirty: false }); },
          onGuardSwitch: function () {
            if (fileSt.dirty && fileSt.selected) {
              return window.confirm(t("personaGuardDirty"));
            }
            return true;
          },
        });
      } else if (tab === "files") {
        body = h(FilesView, {
          t: t, files: data.files, workspace: data.workspace, state: fileSt, setFileState: setFileSt,
          toast: toastMsg, refresh: function () { refresh(); },
        });
      } else if (tab === "inject") {
        body = h(InjectView, {
          t: t, blocks: injSt.blocks || [], injDirty: injSt.dirty,
          setBlocks: function (nb, dirty) { setInjSt({ blocks: nb, dirty: dirty }); },
          setBusy: setBusy, toast: toastMsg,
        });
      } else {
        body = h(PreviewView, {
          t: t, pv: pvSt.pv, pvLoading: pvSt.loading, loadPreview: loadPreview,
        });
      }

      return h("div", { className: ocw_cls("root") },
        h("div", null,
          h("div", { className: ocw_cls("hd") + "-t" }, t("title")),
          h("div", { className: ocw_cls("hd") + "-s" }, t("blurb"))),
        h("div", { className: ocw_cls("tabs") },
          ["persona", "files", "inject", "preview"].map(function (k) {
            return h("button", {
              key: k, className: ocw_cls("tab"), "data-on": tab === k ? "1" : "0",
              onClick: function () { setTab(k); },
            }, t({ persona: "tabPersona", files: "tabFiles", inject: "tabInject", preview: "tabPreview" }[k]));
          })),
        body,
        h(Toast, { msg: toast && toast.msg, err: toast && toast.err })
      );
    }

    // ───────────────────────── 插件体 ─────────────────────────
    var inject = ["slots", "locale"];

    function apply(ctx) {
      if (!React) { try { console.warn("[claw-space] react 不可用，跳过设置页"); } catch (e) {} return; }
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== "function") {
        try { console.warn("[claw-space] ctx.slots 不可用，跳过设置页"); } catch (e) {}
        return;
      }

      try {
        if (ctx.locale && typeof ctx.locale.register === "function") {
          ctx.locale.register(NS, { zh: UI_zh, en: UI_en });
        }
      } catch (e) {}

      try {
        ctx.slots.inject("settings.section", function () {
          return ctx.slots.register({
            name: "settings.section",
            id: "claw-space",
            order: 59,
            label: function () { return makeT()("nav"); },
            locale: NS,
            inject: function () { return { t: makeT() }; },
          }, function () { return React.createElement(View, null); });
        });
        try { console.log("[claw-space] 设置页「OpenClaw 工作区」已注册"); } catch (e) {}
      } catch (e) {
        try { console.error("[claw-space] 设置页注册失败", e); } catch (e2) {}
      }
    }

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
