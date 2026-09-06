// dsh-url-trace 客户端 bundle 的本地模拟测试：
// 模拟 DSH 客户端环境（模块加载器 + 最小 ctx + react/react-dom 真实包），
// 完整走一遍 物化 → apply → 插槽声明 → 按钮渲染。
// 依赖解析：优先环境变量 DSH_TEST_NODE_MODULES，其次 DSH_HOME，最后 ~/.dsh。
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const NODE_MODULES = process.env.DSH_TEST_NODE_MODULES
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), "profiles", "node_modules");
const BUNDLE = path.resolve(__dirname, "../lib/client.js");

let failures = 0;
function check(name, ok, extra) {
  console.log((ok ? "  PASS " : "  FAIL ") + name + (extra ? " — " + extra : ""));
  if (!ok) failures++;
}

/* ---------- 模拟 document / window / localStorage ---------- */
function makeElementMock() {
  return {
    dataset: {}, textContent: "", isConnected: true, style: {},
    appendChild() {}, remove() {}, addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }
  };
}
const documentMock = {
  head: makeElementMock(),
  body: makeElementMock(),
  createElement: () => makeElementMock(),
  addEventListener() {}, removeEventListener() {}
};
const localStorageMock = (() => {
  let data = {};
  return {
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; }
  };
})();
// 预置旧版存量数据：同一页面的 URL 变体 + 收藏状态，验证迁移合并
localStorageMock.setItem("dsh-url-trace:v1", JSON.stringify({
  v: 1,
  sites: {
    "https://www.bilibili.com/video/BV1X/?spm_id_from=1": {
      urlKey: "https://www.bilibili.com/video/BV1X/?spm_id_from=1",
      url: "https://www.bilibili.com/video/BV1X/?spm_id_from=1",
      host: "www.bilibili.com", title: "A", firstTs: 1, lastTs: 2, count: 3, pinned: true, tags: []
    },
    "https://bilibili.com/video/BV1X": {
      urlKey: "https://bilibili.com/video/BV1X",
      url: "https://bilibili.com/video/BV1X",
      host: "bilibili.com", title: "B", firstTs: 3, lastTs: 4, count: 4, pinned: false, tags: []
    }
  },
  visits: [{ urlKey: "https://www.bilibili.com/video/BV1X/?spm_id_from=1", url: "https://www.bilibili.com/video/BV1X/?spm_id_from=1", host: "www.bilibili.com", title: "A", ts: 1 }],
  pins: {}
}));
const windowMock = {
  __ModuleLoader__: { load: (handoff) => { throw new Error("window.__ModuleLoader__.load replaced before bundle run"); } },
  confirm: () => true
};

let handoff = null;
windowMock.__ModuleLoader__.load = (h) => { handoff = h; };

const sandbox = {
  window: windowMock,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  queueMicrotask: (fn) => fn(),
  localStorage: localStorageMock,
  document: documentMock,
  URL: require("url").URL,
  URLSearchParams: require("url").URLSearchParams
};
sandbox.globalThis = sandbox;

/* ---------- 运行 bundle（只注册 factory） ---------- */
vm.createContext(sandbox);
try {
  vm.runInContext(fs.readFileSync(BUNDLE, "utf8"), sandbox, { filename: "client.js" });
  check("bundle 执行并注册 factory", handoff !== null && handoff.id === "dsh-url-trace");
} catch (e) {
  check("bundle 执行并注册 factory", false, e.stack);
  process.exit(1);
}

/* ---------- 真实 react / react-dom ---------- */
const react = require(path.join(NODE_MODULES, "react"));
const reactDomServer = require(path.join(NODE_MODULES, "react-dom", "server"));

const requireMock = (spec) => {
  if (spec === "react") return react;
  if (spec === "react/jsx-runtime") return require(path.join(NODE_MODULES, "react", "jsx-runtime"));
  if (spec === "react-dom") return require(path.join(NODE_MODULES, "react-dom"));
  throw new Error("unexpected require in mock: " + spec);
};

/* ---------- 物化 ---------- */
let pluginModule;
try {
  pluginModule = handoff.factory(requireMock);
  check("factory 物化（require react/react-dom/jsx-runtime + localStorage）", true);
} catch (e) {
  check("factory 物化", false, e.stack);
  process.exit(1);
}
check("exports.apply 存在", typeof pluginModule.apply === "function");
check("exports.inject = ['slots']", Array.isArray(pluginModule.inject) && pluginModule.inject[0] === "slots");

/* ---------- 场景 0：存量数据迁移去重 ---------- */
console.log("场景 0：存量数据迁移去重");
const S0 = pluginModule.__test.getStore();
check("迁移后合并为 1 条", Object.keys(S0.sites).length === 1, JSON.stringify(Object.keys(S0.sites)));
check("次数相加 3+4=7", S0.sites["https://bilibili.com/video/BV1X"] && S0.sites["https://bilibili.com/video/BV1X"].count === 7);
check("收藏状态迁移", S0.pins["https://bilibili.com/video/BV1X"] === true);
check("visits 重新映射", S0.visits.length === 1 && S0.visits[0].urlKey === "https://bilibili.com/video/BV1X");
check("normalizeUrl 尾斜杠", pluginModule.__test.normalizeUrl("https://x.com/path/") === "https://x.com/path");
check("normalizeUrl 去追踪参数", pluginModule.__test.normalizeUrl("https://x.com/p?spm_id_from=1&vd_source=a&id=9") === "https://x.com/p?id=9");
check("dedupKey 去 www", pluginModule.__test.dedupKey("https://www.douyin.com/") === "https://douyin.com");

/* ---------- 模拟 ctx（slots 声明等待 + effect 立即执行） ---------- */
function makeCtx() {
  const slots = {
    declared: new Set(),
    pending: new Map(),
    registrations: [],
    inject(key, cb) {
      if (this.declared.has(key)) { ctx.effect(cb, "slots.inject(" + key + ")"); }
      else { this.pending.set(key, cb); }
    },
    declare(key) {
      this.declared.add(key);
      const cb = this.pending.get(key);
      if (cb) { this.pending.delete(key); ctx.effect(cb, "slots.inject(" + key + ")"); }
    },
    register(options, component) {
      this.registrations.push({ options, component });
      return () => {};
    }
  };
  const ctx = {
    slots,
    effect: (fn, desc) => {
      try { return fn(); } catch (e) { throw new Error("effect failed [" + desc + "]: " + (e && e.stack || e)); }
    }
  };
  return ctx;
}

/* ---------- 场景 1：sidebar 尚未声明插槽时 apply（真实启动顺序） ---------- */
console.log("场景 1：apply 时 sidebar.footer.action 尚未声明（真实启动顺序）");
const ctx1 = makeCtx();
try {
  pluginModule.apply(ctx1);
  check("apply 不抛异常", true);
} catch (e) {
  check("apply 不抛异常", false, e.stack);
}
check("未声明时 register 不提前调用", ctx1.slots.registrations.length === 0);

try { ctx1.slots.declare("conversation.input.left"); } catch (e) { check("插槽声明后 inject 回调执行", false, e.stack); }
check("插槽声明后 register 被调用", ctx1.slots.registrations.length === 1);
if (ctx1.slots.registrations.length === 1) {
  const reg = ctx1.slots.registrations[0];
  check("注册选项正确", reg.options.name === "conversation.input.left" && reg.options.id === "dsh-url-trace.view", JSON.stringify(reg.options));

  /* ---------- 渲染按钮（wide=true / false / 输入栏紧凑版） ---------- */
  try {
    const htmlWide = reactDomServer.renderToString(react.createElement(reg.component, { wide: true }));
    console.log("  HTML(wide): " + JSON.stringify(htmlWide));
    check("按钮渲染（展开态）不抛异常", true);
    check("展开态包含「网址足迹」", htmlWide.includes("网址足迹"), "len=" + htmlWide.length);
    const htmlRail = reactDomServer.renderToString(react.createElement(reg.component, { wide: false }));
    console.log("  HTML(rail): " + JSON.stringify(htmlRail));
    check("按钮渲染（收起态）不抛异常", true);
    check("收起态只显示图标", htmlRail.includes("urt-button-icon") && !htmlRail.includes("urt-button-label"), "len=" + htmlRail.length);
    const htmlComp = reactDomServer.renderToString(react.createElement(reg.component, {}));
    check("输入栏工具行按钮渲染（紧凑图标版）", htmlComp.includes("urt-button-composer") && htmlComp.includes("urt-button-icon"));
  } catch (e) {
    check("按钮渲染", false, e.stack);
  }
}

/* ---------- 场景 2：apply 时插槽已声明 ---------- */
console.log("场景 2：apply 时 conversation.input.left 已声明");
const ctx2 = makeCtx();
ctx2.slots.declared.add("conversation.input.left");
try {
  pluginModule.apply(ctx2);
  check("apply 不抛异常", true);
  check("已声明时立即 register", ctx2.slots.registrations.length === 1);
} catch (e) {
  check("apply（已声明）", false, e.stack);
}

/* ---------- 场景 3：Edge 历史合并 ---------- */
console.log("场景 3：Edge 历史合并与收藏/隐藏");
const T = pluginModule.__test;
// 清掉场景 0 的迁移数据，构造干净环境
const S3 = T.getStore();
S3.sites = {};
S3.visits = [];
S3.pins = {};
S3.ignored = {};
S3.autoPinExcluded = {};
S3.categories = {};
S3.lastOrganize = null;
T.recordVisit("https://a.example.com/page", "DSH 页面");
T.togglePin("https://a.example.com/page");
const merged = T.mergedEntries([
  { url: "https://a.example.com/page?utm_source=x", title: "Edge 同一页", count: 7, lastTs: Date.now() - 5000 },
  { url: "https://b.example.com/", title: "纯 Edge 页", count: 3, lastTs: Date.now() - 1000 }
]);
console.log("  merged keys: " + JSON.stringify(merged.map((m) => [m.urlKey, m.source, m.count])));
check("合并后 2 条", merged.length === 2, "len=" + merged.length);
const a = merged.find((m) => m.urlKey === "https://a.example.com/page");
check("同 URL 次数相加 (1+7=8)", !!a && a.count === 8, a ? "count=" + a.count : "missing");
check("跨源标记 both", !!a && a.source === "both");
check("收藏状态保留", !!a && a.pinned === true);
const b = merged.find((m) => m.urlKey === "https://b.example.com");
check("纯 Edge 标记 edge", !!b && b.source === "edge");
T.removeEntry(b);
const after = T.mergedEntries([{ url: "https://b.example.com/", title: "B", count: 3, lastTs: Date.now() }]);
check("隐藏后不再出现", !after.some((m) => m.urlKey === "https://b.example.com"));

/* ---------- 场景 4：分类与自动收藏 ---------- */
console.log("场景 4：规则分类与自动收藏");
check("bilibili → video", T.ruleCategory("https://www.bilibili.com/video/BV1xx", "某视频") === "video");
check("github → dev", T.ruleCategory("https://github.com/x/y", "") === "dev");
check("未知 → other", T.ruleCategory("https://unknown-random-site.example.com/thing", "") === "other");

const S = T.getStore();
// 重置场景 3 的数据，构造自动收藏候选
S.sites = {};
S.visits = [];
S.pins = {};
S.ignored = {};
S.autoPinExcluded = {};
S.categories = {};
S.lastOrganize = null;
S.settings = { autoPin: true, autoPinMinCount: 5, autoPinRecentDays: 30, excludeCategories: ["search", "other"] };
const now4 = Date.now();
S.sites["https://www.bilibili.com/video/BV1xx"] = { urlKey: "https://www.bilibili.com/video/BV1xx", url: "https://www.bilibili.com/video/BV1xx", host: "www.bilibili.com", title: "某视频", firstTs: now4, lastTs: now4, count: 8, pinned: false, tags: [] };
S.sites["https://www.baidu.com/s?wd=x"] = { urlKey: "https://www.baidu.com/s?wd=x", url: "https://www.baidu.com/s?wd=x", host: "www.baidu.com", title: "x_百度搜索", firstTs: now4, lastTs: now4, count: 8, pinned: false, tags: [] };
S.sites["https://rare.example.com/a"] = { urlKey: "https://rare.example.com/a", url: "https://rare.example.com/a", host: "rare.example.com", title: "A", firstTs: now4, lastTs: now4, count: 3, pinned: false, tags: [] };
S.sites["https://old.example.com/b"] = { urlKey: "https://old.example.com/b", url: "https://old.example.com/b", host: "old.example.com", title: "B", firstTs: now4 - 60 * 86400000, lastTs: now4 - 60 * 86400000, count: 9, pinned: false, tags: [] };
const all4 = T.mergedEntries([]);
const pinned = T.autoPin(all4);
check("视频类 8 次 → 自动收藏", pinned.includes("https://www.bilibili.com/video/BV1xx"), JSON.stringify(pinned));
check("搜索类不计", !pinned.includes("https://www.baidu.com/s?wd=x"));
check("次数不足不计", !pinned.includes("https://rare.example.com/a"));
check("过期不计", !pinned.includes("https://old.example.com/b"));
check("收藏状态已写入", T.isPinned("https://www.bilibili.com/video/BV1xx") === true);

// 手动取消 → 豁免，再次整理不再收藏
T.togglePin("https://www.bilibili.com/video/BV1xx");
check("手动取消后不再收藏", T.isPinned("https://www.bilibili.com/video/BV1xx") === false);
const pinned2 = T.autoPin(T.mergedEntries([]));
check("豁免名单生效", !pinned2.includes("https://www.bilibili.com/video/BV1xx"));

// 撤销上次整理
T.undoOrganize();
check("撤销后快照清空", S.lastOrganize === null);

/* ---------- 场景 5：URL 变体去重（www / 追踪参数 / 尾斜杠） ---------- */
console.log("场景 5：URL 变体去重");
S.sites = {};
S.visits = [];
S.pins = {};
S.ignored = {};
S.autoPinExcluded = {};
S.categories = {};
S.lastOrganize = null;
T.recordVisit("https://www.bilibili.com/video/BV1X/?spm_id_from=333.999&vd_source=abc", "视频A");
S.sites["https://bilibili.com/video/BV1X"].lastTs = Date.now() - 20 * 60000; // 越过去重窗口
T.recordVisit("https://bilibili.com/video/BV1X", "视频B");
const m5 = T.mergedEntries([{ url: "https://www.bilibili.com/video/BV1X/?ug_source=mz", title: "Edge 同页", count: 5, lastTs: Date.now() - 100 }]);
check("变体合并为 1 条", m5.length === 1, "len=" + m5.length);
check("次数相加 (2+5=7)", m5[0].count === 7, "count=" + m5[0].count);
check("key 为裸域无参数", m5[0].urlKey === "https://bilibili.com/video/BV1X", m5[0].urlKey);
check("来源标记 both", m5[0].source === "both");

/* ---------- 场景 6：面板拖拽边界 ---------- */
console.log("场景 6：面板拖拽边界（clampPanel）");
const d1 = T.clampPanel(500, 200, 400, 600, 1200, 800);
check("常规位置不夹紧", d1.x === 500 && d1.y === 200);
const d2 = T.clampPanel(-999, -999, 400, 600, 1200, 800);
check("左上越界夹紧", d2.x === 60 - 400 && d2.y === 60 - 600, d2.x + "," + d2.y);
const d3 = T.clampPanel(9999, 9999, 400, 600, 1200, 800);
check("右下越界夹紧", d3.x === 1200 - 60 && d3.y === 800 - 60, d3.x + "," + d3.y);

console.log(failures === 0 ? "== 全部通过 ==" : "== 有 " + failures + " 项失败 ==");
process.exit(failures === 0 ? 0 : 1);
