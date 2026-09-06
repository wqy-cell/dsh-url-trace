// dsh-url-trace — browser half. 网址足迹。
// 1) 全局捕获从 DSH 页面打开的网址（<a> 点击 / window.open），写入 localStorage；
// 2) 在聊天输入栏工具行（conversation.input.left 插槽）注册查看按钮；
// 3) 点击按钮打开面板：常用（频次×时间衰减）/ 最近 / 收藏 + 即时搜索。
window.__ModuleLoader__.load({
  id: "dsh-url-trace",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let react_dom = require("react-dom");
    let jsxRuntime = require("react/jsx-runtime");

    /** jsx-runtime 的 children 必须放在 props.children；h() 统一成 createElement 风格。
     *  静态多子元素走 jsxs（无需 key），单/零子元素走 jsx。 */
    function h(type, props, ...children) {
      const p = props ? Object.assign({}, props) : {};
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return children.length > 1 ? jsxRuntime.jsxs(type, p) : jsxRuntime.jsx(type, p);
    }

    /* ================= 存储（localStorage） ================= */

    const STORE_KEY = "dsh-url-trace:v1";
    const MAX_SITES = 2000;
    const MAX_VISITS = 2000;
    const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

    function loadStore() {
      try {
        const raw = localStorage.getItem(STORE_KEY);
        if (raw) {
          const data = JSON.parse(raw);
          if (data && data.v === 1 && data.sites && Array.isArray(data.visits)) {
            // 迁移：旧数据没有这些字段
            if (!data.pins) {
              data.pins = {};
              Object.keys(data.sites).forEach((k) => { if (data.sites[k].pinned) data.pins[k] = true; });
            }
            if (!data.ignored) data.ignored = {};
            if (!data.categories) data.categories = {};
            if (!data.autoPinExcluded) data.autoPinExcluded = {};
            data.settings = Object.assign({ autoPin: true, autoPinMinCount: 5, autoPinRecentDays: 30, excludeCategories: ["search", "other"] }, data.settings || {});
            if (!data.lastOrganize) data.lastOrganize = null;
            // 去重迁移：把所有 key 重算为 dedupKey，合并同页变体（www / 追踪参数 / 尾斜杠）
            if (!data.__deduped) {
              const sites = {};
              const pins = data.pins || {};
              const cats = data.categories || {};
              const ign = data.ignored || {};
              const apx = data.autoPinExcluded || {};
              const nPins = {}, nCats = {}, nIgn = {}, nApx = {};
              Object.entries(data.sites).forEach(([oldKey, s]) => {
                const k = dedupKey(s.url) || oldKey;
                const ex = sites[k];
                if (ex) {
                  ex.count = (ex.count || 0) + (s.count || 1);
                  if ((s.lastTs || 0) > (ex.lastTs || 0)) { ex.lastTs = s.lastTs; if (s.title) ex.title = s.title; }
                  if (s.firstTs && (!ex.firstTs || s.firstTs < ex.firstTs)) ex.firstTs = s.firstTs;
                } else {
                  sites[k] = Object.assign({}, s, { urlKey: k, count: s.count || 1 });
                }
                if (s.pinned || pins[oldKey]) nPins[k] = true;
                if (cats[oldKey]) nCats[k] = cats[oldKey];
                if (ign[oldKey]) nIgn[k] = true;
                if (apx[oldKey]) nApx[k] = true;
              });
              data.sites = sites;
              data.pins = nPins;
              data.categories = nCats;
              data.ignored = nIgn;
              data.autoPinExcluded = nApx;
              data.lastOrganize = null;
              data.visits = (data.visits || []).map((v) => Object.assign({}, v, { urlKey: dedupKey(v.url) || v.urlKey }));
              data.__deduped = true;
            }
            return data;
          }
        }
      } catch (e) { /* 损坏则重建 */ }
      return {
        v: 1, sites: {}, visits: [], pins: {}, ignored: {},
        categories: {}, autoPinExcluded: {},
        settings: { autoPin: true, autoPinMinCount: 5, autoPinRecentDays: 30, excludeCategories: ["search", "other"] },
        lastOrganize: null
      };
    }

    let store = loadStore();
    const storeListeners = new Set();

    function save() {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* 忽略配额错误 */ }
      storeListeners.forEach((fn) => { try { fn(); } catch (e) { /* ignore */ } });
    }
    function onStoreChange(fn) {
      storeListeners.add(fn);
      return () => { storeListeners.delete(fn); };
    }

    /** 容量保护：明细与站点各自封顶，超限丢最旧的。 */
    function prune() {
      if (store.visits.length > MAX_VISITS) {
        store.visits = store.visits.slice(store.visits.length - MAX_VISITS);
      }
      const keys = Object.keys(store.sites);
      if (keys.length > MAX_SITES) {
        const ordered = keys
          .map((k) => store.sites[k])
          .sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));
        const drop = new Set(ordered.slice(0, keys.length - MAX_SITES).map((s) => s.urlKey));
        const next = {};
        keys.forEach((k) => { if (!drop.has(k)) next[k] = store.sites[k]; });
        store.sites = next;
      }
    }

    /* ================= URL 工具 ================= */

    /** 规范化网址：仅 http/https；去 hash、追踪参数、默认端口、尾斜杠。 */
    function normalizeUrl(raw) {
      if (!raw) return null;
      let u;
      try { u = new URL(raw); } catch (e) { return null; }
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const DROP = [
        "fbclid", "gclid", "dclid", "gclsrc", "igshid",
        "spm", "spm_id_from", "spm_id",
        "vd_source", "share_source", "share_medium", "share_plat", "share_tag", "from_spmid", "from_source",
        "plat_id", "session_id", "request_id", "req_id", "track_id", "up_id",
        "ug_source", "ug_medium", "ug_campaign",
        "from", "source", "ref", "ref_src"
      ];
      [...u.searchParams.keys()].forEach((k) => {
        const lk = k.toLowerCase();
        if (lk.startsWith("utm_") || DROP.includes(lk)) u.searchParams.delete(k);
      });
      u.hostname = u.hostname.toLowerCase();
      u.hash = "";
      try {
        if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
      } catch (e) { /* ignore */ }
      if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
      if (u.pathname === "/" && u.search === "" && u.hash === "") return u.origin;
      return u.href;
    }

    /** 去重键：规范化后再去掉 www.，让 www 与裸域归为同一条记录。 */
    function dedupKey(raw) {
      const u = normalizeUrl(raw);
      if (!u) return null;
      return u.replace(/^https?:\/\/www\./, (m) => m.slice(0, m.length - 4));
    }

    function hostOf(url) {
      try { return new URL(url).hostname; } catch (e) { return ""; }
    }

    /** 常用度：访问次数 ÷ 时间衰减。 */
    function scoreOf(site, now) {
      const last = site.lastTs || site.firstTs || now;
      const days = Math.max(0, (now - last) / 86400000);
      return (site.count || 1) / Math.pow(days + 1, 0.65);
    }

    function formatRelative(ts) {
      const diff = Date.now() - ts;
      if (diff < 60000) return "刚刚";
      const m = Math.floor(diff / 60000);
      if (m < 60) return m + "分钟前";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "小时前";
      const d = Math.floor(h / 24);
      if (d === 1) return "昨天";
      if (d < 7) return d + "天前";
      const dt = new Date(ts);
      const pad = (n) => String(n).padStart(2, "0");
      const md = pad(dt.getMonth() + 1) + "-" + pad(dt.getDate());
      return dt.getFullYear() === new Date().getFullYear() ? md : dt.getFullYear() + "-" + md;
    }

    /* ================= 分类 ================= */

    const CATEGORIES = [
      { id: "search", name: "搜索", color: "#6b7280" },
      { id: "video", name: "视频娱乐", color: "#ef4444" },
      { id: "social", name: "社交社区", color: "#8b5cf6" },
      { id: "shopping", name: "购物", color: "#f59e0b" },
      { id: "dev", name: "技术开发", color: "#0ea5e9" },
      { id: "news", name: "新闻资讯", color: "#14b8a6" },
      { id: "study", name: "学习教育", color: "#10b981" },
      { id: "tools", name: "工具AI", color: "#6366f1" },
      { id: "other", name: "其他", color: "#9ca3af" }
    ];

    const CAT_META = {};
    CATEGORIES.forEach((c) => { CAT_META[c.id] = c; });

    /** 分类规则：域名优先，标题关键词兜底；未命中 → other。 */
    const CATEGORY_RULES = [
      { id: "search", domains: ["google.com", "google.com.hk", "bing.com", "baidu.com", "sogou.com", "so.com", "duckduckgo.com", "sm.cn", "yandex.com", "search.brave.com"], keywords: [] },
      { id: "video", domains: ["bilibili.com", "douyin.com", "youtube.com", "iqiyi.com", "youku.com", "v.qq.com", "huya.com", "douyu.com", "netflix.com", "acfun.cn", "mgtv.com", "ixigua.com", "kuaishou.com", "twitch.tv", "vimeo.com", "qq.com/x/", "live.bilibili.com"], keywords: ["直播", "视频", "电影", "电视剧", "综艺", "动漫", "番剧", "追剧", "影院"] },
      { id: "social", domains: ["weibo.com", "weibo.cn", "zhihu.com", "xiaohongshu.com", "tieba.baidu.com", "douban.com", "twitter.com", "x.com", "reddit.com", "facebook.com", "instagram.com", "discord.com", "t.me", "telegram.org", "mp.weixin.qq.com", "bbs.", "v2ex.com", "hupu.com", "nga.cn"], keywords: ["社区", "论坛", "帖子", "超话", "讨论"] },
      { id: "shopping", domains: ["taobao.com", "tmall.com", "jd.com", "pinduoduo.com", "yangkeduo.com", "1688.com", "amazon.", "suning.com", "vip.com", "aliexpress.com", "ebay.com", "smzdm.com", "mogu.com", "yanxuan.com", "dangdang.com"], keywords: ["购物", "旗舰店", "优惠券", "秒杀", "促销", "下单", "订单", "比价"] },
      { id: "dev", domains: ["github.com", "gitee.com", "gitlab.com", "stackoverflow.com", "csdn.net", "juejin.cn", "segmentfault.com", "developer.mozilla.org", "npmjs.com", "pypi.org", "crates.io", "leetcode.cn", "leetcode.com", "caniuse.com", "huggingface.co", "modelscope.cn", "vercel.com", "cloudflare.com", "docker.com", "kubernetes.io", "medium.com", "dev.to", "typescriptlang.org", "rust-lang.org", "python.org", "nodejs.org", "go.dev", "postman.com", "swagger.io", "openai.com", "aistudio.google.com"], keywords: ["文档", "API", "源码", "代码", "报错", "部署", "教程", "安装", "配置", "commit", "npm", "sdk", "开发", "编程", "接口", "调试", "git"] },
      { id: "news", domains: ["news.qq.com", "news.163.com", "sina.com.cn", "thepaper.cn", "people.com.cn", "xinhuanet.com", "toutiao.com", "cnbeta.com", "ithome.com", "36kr.com", "sspai.com", "ifeng.com", "huanqiu.com", "guancha.cn", "ft.com", "reuters.com", "bbc.com", "cnn.com", "zaobao.com"], keywords: ["新闻", "资讯", "快讯", "报道", "日报", "时评", "热点"] },
      { id: "study", domains: ["mooc", "icourse163.org", "xuetangx.com", "coursera.org", "khanacademy.org", "udemy.com", "w3school.", "runoob.com", "open.163.com", "youdao.com", "shanbay.com", "baicizhan.com", "wikipedia.org", "baike.baidu.com", "zh.wikisource.org"], keywords: ["课程", "学习", "公开课", "单词", "词典", "百科", "复习", "考试", "题库", "讲义"] },
      { id: "tools", domains: ["deepseek.com", "chatgpt.com", "chat.openai.com", "claude.ai", "gemini.google.com", "kimi.moonshot.cn", "doubao.com", "qwen.ai", "notion.so", "feishu.cn", "docs.qq.com", "shimo.im", "yuque.com", "pan.baidu.com", "aliyundrive.com", "quark.cn", "mail.qq.com", "mail.163.com", "outlook.com", "gmail.com", "figma.com", "processon.com", "excalidraw.com", "tinypng.com", "json.cn", "bejson.com", "tool.lu", "regex101.com", "convertio.co", "translate.google.com", "fanyi.baidu.com", "deepl.com"], keywords: ["在线", "工具", "转换", "生成", "翻译", "云盘", "邮箱", "AI助手", "chat"] }
    ];

    /** 规则分类：先域名（更具体者先匹配），再标题关键词；未命中返回 other。 */
    function ruleCategory(url, title) {
      const host = hostOf(url);
      const t = String(title || "").toLowerCase();
      for (const rule of CATEGORY_RULES) {
        if (rule.domains.some((d) => host === d || host.endsWith("." + d))) return rule.id;
      }
      for (const rule of CATEGORY_RULES) {
        if (rule.keywords.length && rule.keywords.some((k) => t.includes(k.toLowerCase()))) return rule.id;
      }
      return "other";
    }

    /** 当前分类：缓存（含 LLM 结果与手动修改）优先，其次规则。 */
    function categoryOf(entry) {
      const cached = store.categories[entry.urlKey];
      if (cached && CAT_META[cached]) return cached;
      return ruleCategory(entry.url, entry.title);
    }

    /** 让 LLM 分类一批规则未命中的网址，返回 { urlKey: categoryId }。 */
    async function classifyViaLlm(items) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const resp = await fetch("/url-trace/categorize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: items.map((e) => ({ url: e.url, title: e.title, host: e.host })) }),
          signal: ctrl.signal
        });
        clearTimeout(timer);
        if (!resp.ok) return {};
        const data = await resp.json();
        return data.ok ? (data.results || {}) : {};
      } catch (e) { return {}; }
    }

    /* ================= 记录 ================= */

    /** 记录一次访问：rawUrl 可以是原始链接，内部规范化并按去重键合并。 */
    function recordVisit(rawUrl, title) {
      const url = normalizeUrl(rawUrl);
      if (!url) return;
      const urlKey = dedupKey(url);
      const now = Date.now();
      const host = hostOf(url);
      const site = store.sites[urlKey];
      if (site) {
        if (now - site.lastTs < DEDUPE_WINDOW_MS) {
          // 去重窗口内：只刷新时间与标题
          site.lastTs = now;
          if (title) site.title = title;
        } else {
          site.count = (site.count || 0) + 1;
          site.lastTs = now;
          if (title) site.title = title;
          store.visits.push({ urlKey: urlKey, url: url, host: host, title: title || "", ts: now });
        }
      } else {
        store.sites[urlKey] = {
          urlKey: urlKey, url: url, host: host, title: title || "",
          firstTs: now, lastTs: now, count: 1, pinned: false, tags: []
        };
        store.visits.push({ urlKey: urlKey, url: url, host: host, title: title || "", ts: now });
      }
      prune();
      save();
    }

    function isPinned(urlKey) {
      return store.pins[urlKey] === true;
    }

    function deleteSite(urlKey) {
      delete store.sites[urlKey];
      store.visits = store.visits.filter((v) => v.urlKey !== urlKey);
    }

    /** 删除（或隐藏）一条合并后的记录：DSH 记录删除，Edge 记录进忽略表。 */
    function removeEntry(entry) {
      if (entry.dsh) deleteSite(entry.urlKey);
      store.ignored[entry.urlKey] = true;
      save();
    }

    function togglePin(urlKey) {
      const next = !isPinned(urlKey);
      if (next) {
        store.pins[urlKey] = true;
        delete store.autoPinExcluded[urlKey];
      } else {
        store.pins[urlKey] = false;
        store.autoPinExcluded[urlKey] = true;
      }
      const s = store.sites[urlKey];
      if (s) s.pinned = next;
      save();
    }

    /** 自动收藏：访问次数与近因达标、非排除分类、未被豁免的网址。返回新收藏的 key 列表。 */
    function autoPin(all) {
      const s = store.settings;
      if (!s.autoPin) return [];
      const now = Date.now();
      const newPins = [];
      for (const e of all) {
        if (store.ignored[e.urlKey] || store.autoPinExcluded[e.urlKey] || store.pins[e.urlKey]) continue;
        if ((e.count || 0) < (s.autoPinMinCount || 5)) continue;
        if (now - (e.lastTs || 0) > (s.autoPinRecentDays || 30) * 86400000) continue;
        const cat = categoryOf(e);
        if ((s.excludeCategories || []).includes(cat)) continue;
        store.pins[e.urlKey] = true;
        if (e.dsh) e.dsh.pinned = true;
        newPins.push(e.urlKey);
      }
      if (newPins.length > 0) {
        store.lastOrganize = { at: now, pinned: newPins };
        save();
      }
      return newPins;
    }

    /** 撤销上次自动收藏（并豁免，避免再次被自动收藏）。 */
    function undoOrganize() {
      const snap = store.lastOrganize;
      if (!snap) return;
      (snap.pinned || []).forEach((k) => {
        store.pins[k] = false;
        store.autoPinExcluded[k] = true;
        const s = store.sites[k];
        if (s) s.pinned = false;
      });
      store.lastOrganize = null;
      save();
    }

    function clearCategoryCache() {
      store.categories = {};
      save();
    }

    function clearAll() {
      store = {
        v: 1, sites: {}, visits: [], pins: {}, ignored: {},
        categories: {}, autoPinExcluded: {},
        settings: { autoPin: true, autoPinMinCount: 5, autoPinRecentDays: 30, excludeCategories: ["search", "other"] },
        lastOrganize: null
      };
      save();
    }

    function totalCount() {
      return Object.keys(store.sites).length;
    }

    /* ================= 图标与头像 ================= */

    const ICONS = {
      clock: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      star: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
      starOff: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>',
      trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>',
      close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>',
      search: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
      refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
      sparkle: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M19 9l1.25-2.75L23 5l-2.75-1.25L19 1l-1.25 2.75L15 5l2.75 1.25L19 9zm-7.5.5L9 4 6.5 9.5 1 12l5.5 2.5L9 20l2.5-5.5L17 12l-5.5-2.5zM19 15l-.94 2.06L16 18l2.06.94L19 21l.94-2.06L22 18l-2.06-.94L19 15z"/></svg>'
    };

    const AVATAR_COLORS = ["#4f46e5", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6"];

    function avatarColor(host) {
      let h = 0;
      for (let i = 0; i < host.length; i++) h = (h * 31 + host.charCodeAt(i)) >>> 0;
      return AVATAR_COLORS[h % AVATAR_COLORS.length];
    }

    function letterOf(host) {
      const clean = String(host || "").replace(/^www\./, "");
      return (clean[0] || "?").toUpperCase();
    }

    /* ================= 面板 ================= */

    /** 合并 DSH 记录与 Edge 历史（按规范化 URL 去重，次数相加、时间取最大）。 */
    function mergedEntries(edgeRows) {
      const map = new Map();

      Object.keys(store.sites).forEach((key) => {
        if (store.ignored[key]) return;
        const s = store.sites[key];
        map.set(key, {
          urlKey: key, url: s.url, host: s.host, title: s.title || key,
          count: s.count || 1, lastTs: s.lastTs || s.firstTs || 0,
          pinned: isPinned(key), source: "dsh", dsh: s
        });
      });

      (edgeRows || []).forEach((e) => {
        const url = normalizeUrl(e.url);
        const key = dedupKey(e.url);
        if (!key || store.ignored[key]) return;
        const ex = map.get(key);
        if (ex) {
          ex.count += e.count || 0;
          if ((e.lastTs || 0) > ex.lastTs) { ex.lastTs = e.lastTs; if (e.title) ex.title = e.title; }
          ex.source = "both";
          ex.pinned = isPinned(key);
        } else {
          map.set(key, {
            urlKey: key, url: url || key, host: hostOf(url || key), title: e.title || key,
            count: e.count || 0, lastTs: e.lastTs || 0,
            pinned: isPinned(key), source: "edge", dsh: null
          });
        }
      });

      return [...map.values()];
    }

    function visibleItems(mode, query, all, catFilter) {
      const now = Date.now();
      const q = query.trim().toLowerCase();
      let items = all;
      if (mode === "pinned") items = items.filter((s) => s.pinned);
      if (catFilter) items = items.filter((s) => categoryOf(s) === catFilter);
      if (q) {
        items = items.filter((s) =>
          (s.title || "").toLowerCase().includes(q) ||
          (s.url || "").toLowerCase().includes(q) ||
          (s.host || "").includes(q)
        );
      }
      items.sort((a, b) => {
        if (mode === "freq" && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        if (mode === "freq") return scoreOf(b, now) - scoreOf(a, now);
        return (b.lastTs || 0) - (a.lastTs || 0);
      });
      return items.slice(0, 200);
    }

    function Row({ site, onCategoryChange }) {
      const [menuOpen, setMenuOpen] = react.useState(false);
      const cat = CAT_META[categoryOf(site)] || CAT_META.other;
      const star = site.pinned ? ICONS.star : ICONS.starOff;
      const srcChip = site.source === "edge"
        ? h("span", { className: "urt-src" }, "Edge")
        : site.source === "both"
          ? h("span", { className: "urt-src" }, "Edge+DSH")
          : null;
      return h("li", { className: "urt-row", onMouseLeave: () => setMenuOpen(false) },
        h("a", {
          className: "urt-main",
          href: site.url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: site.url
        },
          h("span", {
            className: "urt-avatar",
            style: { background: avatarColor(site.host) }
          }, letterOf(site.host)),
          h("span", { className: "urt-texts" },
            h("span", { className: "urt-title" }, site.title || site.host),
            h("span", { className: "urt-meta" },
              h("span", { className: "urt-host" }, site.host),
              " · " + site.count + "次 · " + formatRelative(site.lastTs)
            )
          )
        ),
        h("span", { className: "urt-tags" },
          srcChip,
          h("span", { className: "urt-cat-wrap" },
            h("button", {
              type: "button",
              className: "urt-cat-tag",
              style: { background: cat.color + "26", color: cat.color },
              title: "分类：" + cat.name + "（点击修改）",
              onClick: () => setMenuOpen((v) => !v)
            }, cat.name),
            menuOpen ? h("span", { className: "urt-cat-menu" }, CATEGORIES.map((c) =>
              h("button", {
                key: c.id,
                type: "button",
                className: "urt-cat-item",
                onClick: () => {
                  store.categories[site.urlKey] = c.id;
                  save();
                  if (onCategoryChange) onCategoryChange();
                }
              }, c.name)
            )) : null
          )
        ),
        h("span", { className: "urt-ops" },
          h("button", {
            type: "button",
            className: "urt-op" + (site.pinned ? " on" : ""),
            title: "收藏 / 取消收藏",
            onClick: () => togglePin(site.urlKey),
            dangerouslySetInnerHTML: { __html: star }
          }),
          h("button", {
            type: "button",
            className: "urt-op",
            title: site.source === "edge" ? "隐藏这条 Edge 记录" : "删除记录",
            onClick: () => {
              const name = site.title || site.host;
              const msg = site.source === "edge"
                ? "隐藏这条 Edge 历史记录（之后不再显示）？"
                : "删除「" + name + "」及其全部访问记录？";
              if (window.confirm(msg)) removeEntry(site);
            },
            dangerouslySetInnerHTML: { __html: ICONS.trash }
          })
        )
      );
    }

    const EMPTY_TEXT = {
      freq: "暂无记录 — 在 DSH 里点开的链接和 Edge 历史会自动出现在这里",
      recent: "暂无记录 — 在 DSH 里点开的链接和 Edge 历史会自动出现在这里",
      pinned: "还没有收藏 — 打开面板时会自动整理并收藏常用网址，也可点行内 ★ 手动收藏"
    };

    /** 拖拽边界：面板至少保留 60px 在视口内，拖不丢。 */
    function clampPanel(x, y, w, h, vw, vh) {
      return {
        x: Math.round(Math.max(60 - w, Math.min(x, vw - 60))),
        y: Math.round(Math.max(60 - h, Math.min(y, vh - 60)))
      };
    }

    function Panel({ onClose }) {
      const [, bump] = react.useReducer((x) => x + 1, 0);
      const panelRef = react.useRef(null);
      const dragRef = react.useRef(null);
      const [pos, setPos] = react.useState(null); // null = 默认右上角；{x,y} = 拖动后的左上角
      const [dragging, setDragging] = react.useState(false);
      const [mode, setMode] = react.useState("freq");
      const [query, setQuery] = react.useState("");
      const [catFilter, setCatFilter] = react.useState(null);
      const [edge, setEdge] = react.useState({ entries: [], error: null, loading: false });
      const [edgeReady, setEdgeReady] = react.useState(false);
      const [toastMsg, setToastMsg] = react.useState(null);
      const [organizing, setOrganizing] = react.useState(false);
      const organizedRef = react.useRef(false);
      const toastTimer = react.useRef(null);
      react.useEffect(() => onStoreChange(bump), []);
      react.useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") onClose(); };
        document.addEventListener("keydown", onKey, true);
        return () => document.removeEventListener("keydown", onKey, true);
      }, []);

      // 拖动：按住标题栏移动面板（按钮除外），边界夹紧
      react.useEffect(() => {
        if (!dragging) return;
        const move = (e) => {
          const d = dragRef.current;
          const panel = panelRef.current;
          if (!d || !panel) return;
          setPos(clampPanel(
            d.startX + (e.clientX - d.pointerX),
            d.startY + (e.clientY - d.pointerY),
            panel.offsetWidth, panel.offsetHeight,
            window.innerWidth, window.innerHeight
          ));
        };
        const up = () => setDragging(false);
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", up);
        return () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          window.removeEventListener("pointercancel", up);
        };
      }, [dragging]);

      // 拖到自定义位置后，窗口缩放时重新夹紧
      react.useEffect(() => {
        if (!pos) return;
        const onResize = () => {
          const panel = panelRef.current;
          if (!panel) return;
          setPos(clampPanel(pos.x, pos.y, panel.offsetWidth, panel.offsetHeight, window.innerWidth, window.innerHeight));
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
      }, [pos ? pos.x + "|" + pos.y : ""]);

      const startDrag = (e) => {
        if (e.target && e.target.closest && e.target.closest("button")) return;
        const panel = panelRef.current;
        if (!panel) return;
        const r = panel.getBoundingClientRect();
        dragRef.current = { startX: r.left, startY: r.top, pointerX: e.clientX, pointerY: e.clientY };
        setDragging(true);
        if (e.cancelable) e.preventDefault();
      };

      const showToast = (m) => {
        setToastMsg(m);
        clearTimeout(toastTimer.current);
        toastTimer.current = setTimeout(() => setToastMsg(null), 3500);
      };

      const loadEdge = async (force) => {
        setEdge((s) => ({ entries: s.entries, error: s.error, loading: true }));
        try {
          const resp = await fetch("/url-trace/edge-history" + (force ? "?force=1" : ""));
          if (!resp.ok) throw new Error("HTTP " + resp.status);
          const data = await resp.json();
          if (data.ok) setEdge({ entries: data.entries || [], error: null, loading: false });
          else setEdge({ entries: [], error: data.error || "读取失败", loading: false });
          setEdgeReady(true);
        } catch (e) {
          setEdge({ entries: [], error: String((e && e.message) || e), loading: false });
          setEdgeReady(true);
        }
      };
      react.useEffect(() => { loadEdge(false); }, []);

      /** 整理：规则外的网址交给 LLM 分类（一次，缓存），再按标准自动收藏。 */
      const runOrganize = async (manual) => {
        if (organizing) return;
        setOrganizing(true);
        try {
          const before = mergedEntries(edge.entries);
          const need = before
            .filter((e) => !store.categories[e.urlKey] && ruleCategory(e.url, e.title) === "other")
            .slice(0, 40);
          let classified = 0;
          if (need.length > 0) {
            const results = await classifyViaLlm(need);
            need.forEach((e) => {
              const cat = results[e.urlKey];
              if (cat && CAT_META[cat]) { store.categories[e.urlKey] = cat; classified += 1; }
            });
            if (classified > 0) save();
          }
          const fresh = mergedEntries(edge.entries);
          const pinned = autoPin(fresh);
          bump();
          if (manual || classified > 0 || pinned.length > 0) {
            const parts = [];
            if (classified > 0) parts.push("智能分类 " + classified + " 个");
            if (pinned.length > 0) parts.push("自动收藏 " + pinned.length + " 个");
            showToast(parts.length ? "整理完成：" + parts.join("，") : "整理完成：没有新变化");
          }
        } finally {
          setOrganizing(false);
        }
      };
      react.useEffect(() => {
        if (!edgeReady || organizedRef.current) return;
        organizedRef.current = true;
        runOrganize(false);
      }, [edgeReady]);

      const all = mergedEntries(edge.entries);
      const items = mode === "settings" ? [] : visibleItems(mode, query, all, catFilter);
      const total = all.length;
      const settings = store.settings;

      const catCounts = {};
      all.forEach((e) => { const c = categoryOf(e); catCounts[c] = (catCounts[c] || 0) + 1; });

      const tabs = [["freq", "常用"], ["recent", "最近"], ["pinned", "收藏"], ["settings", "设置"]];

      // 列表分组：常用模式下「收藏 / 全部」两段式
      const listItems = [];
      items.forEach((site, i) => {
        const showLabel = mode === "freq" && !query && !catFilter
          && (i === 0 ? site.pinned : site.pinned !== items[i - 1].pinned);
        if (showLabel) {
          listItems.push(h("li", { key: "label-" + i, className: "urt-sec-label" }, site.pinned ? "★ 收藏" : "全部"));
        }
        listItems.push(h(Row, { key: site.urlKey, site: site, onCategoryChange: bump }));
      });

      const settingsPane = h("div", { className: "urt-settings" },
        h("div", { className: "urt-set-group" }, "自动整理"),
        h("label", { className: "urt-set-row" },
          h("input", { type: "checkbox", checked: settings.autoPin, onChange: (e) => { settings.autoPin = e.target.checked; save(); bump(); } }),
          " 打开面板时自动整理（智能分类 + 自动收藏）"
        ),
        h("div", { className: "urt-set-row" },
          "访问 ≥ ",
          h("input", {
            type: "number", className: "urt-set-num", min: 1, max: 100,
            value: settings.autoPinMinCount,
            onChange: (e) => { settings.autoPinMinCount = Math.max(1, Number(e.target.value) || 5); save(); bump(); }
          }),
          " 次，且最近 ",
          h("input", {
            type: "number", className: "urt-set-num", min: 1, max: 365,
            value: settings.autoPinRecentDays,
            onChange: (e) => { settings.autoPinRecentDays = Math.max(1, Number(e.target.value) || 30); save(); bump(); }
          }),
          " 天内访问过"
        ),
        h("div", { className: "urt-set-group" }, "排除分类"),
        h("div", { className: "urt-set-row urt-set-col" },
          h("div", { className: "urt-set-chips" }, CATEGORIES.map((c) => {
            const on = settings.excludeCategories.includes(c.id);
            return h("button", {
              key: c.id,
              type: "button",
              className: "urt-cat-chip" + (on ? " off" : ""),
              style: on ? {} : { borderColor: c.color, color: c.color },
              onClick: () => {
                if (on) settings.excludeCategories = settings.excludeCategories.filter((x) => x !== c.id);
                else settings.excludeCategories.push(c.id);
                save(); bump();
              }
            }, c.name);
          }))
        ),
        h("div", { className: "urt-set-group" }, "数据"),
        h("div", { className: "urt-set-actions" },
          h("button", {
            type: "button", className: "urt-clear", disabled: !store.lastOrganize,
            onClick: () => { undoOrganize(); bump(); showToast("已撤销上次自动收藏"); }
          }, "撤销上次自动收藏"),
          h("button", {
            type: "button", className: "urt-clear",
            onClick: () => { clearCategoryCache(); bump(); showToast("分类缓存已清空，下次打开重新智能分类"); }
          }, "清空分类缓存")
        ),
        h("div", { className: "urt-set-note" },
          "说明：常见网站由规则库即时分类；规则库不认识的交给你的 DSH 模型智能分类（每个网址仅一次，结果本地缓存）。达到次数与时间标准的常用网址自动加入收藏；你手动取消过的网址不会再被自动收藏。")
      );

      const panelStyle = pos
        ? { left: pos.x + "px", top: pos.y + "px", right: "auto" }
        : null;

      return react_dom.createPortal(
        h("div", {
          className: "urt-overlay",
          onClick: (e) => { if (e.target === e.currentTarget) onClose(); }
        },
          h("div", {
            ref: panelRef,
            className: "urt-panel" + (dragging ? " urt-dragging" : ""),
            style: panelStyle,
            onClick: (e) => e.stopPropagation()
          },
            h("div", { className: "urt-head", onPointerDown: startDrag },
              h("span", { className: "urt-head-title" },
                h("span", { className: "urt-head-icon", dangerouslySetInnerHTML: { __html: ICONS.clock } }),
                "网址足迹"
              ),
              h("span", { className: "urt-head-right" },
                h("span", { className: "urt-head-count" }, String(total) + " 个网址"),
                h("button", {
                  type: "button",
                  className: "urt-iconbtn" + (organizing ? " spinning" : ""),
                  title: "一键整理（智能分类 + 自动收藏）",
                  onClick: () => runOrganize(true),
                  dangerouslySetInnerHTML: { __html: ICONS.sparkle }
                }),
                h("button", {
                  type: "button",
                  className: "urt-iconbtn" + (edge.loading ? " spinning" : ""),
                  title: "重新读取 Edge 历史",
                  onClick: () => loadEdge(true),
                  dangerouslySetInnerHTML: { __html: ICONS.refresh }
                }),
                h("button", {
                  type: "button",
                  className: "urt-iconbtn",
                  title: "关闭 (Esc)",
                  onClick: onClose,
                  dangerouslySetInnerHTML: { __html: ICONS.close }
                })
              )
            ),
            h("div", { className: "urt-search" },
              h("span", { className: "urt-search-icon", dangerouslySetInnerHTML: { __html: ICONS.search } }),
              h("input", {
                type: "text",
                className: "urt-search-input",
                placeholder: "搜索标题 / 网址 / 域名",
                autoFocus: true,
                value: query,
                onChange: (e) => setQuery(e.target.value)
              }),
              query
                ? h("button", {
                    type: "button",
                    className: "urt-search-clear",
                    title: "清空搜索",
                    onClick: () => setQuery("")
                  }, h("span", { dangerouslySetInnerHTML: { __html: ICONS.close } }))
                : null
            ),
            edge.error
              ? h("div", { className: "urt-edge-error" }, "Edge 历史读取失败：" + edge.error + "（重启 dsh web 后可恢复）")
              : null,
            h("div", { className: "urt-tabs" }, tabs.map(([key, label]) =>
              h("button", {
                key: key,
                type: "button",
                className: "urt-tab" + (mode === key ? " active" : ""),
                onClick: () => setMode(key)
              }, label)
            )),
            mode !== "settings"
              ? h("div", { className: "urt-cats" },
                  h("button", {
                    key: "__all", type: "button",
                    className: "urt-cat-chip" + (catFilter === null ? " active" : ""),
                    onClick: () => setCatFilter(null)
                  }, "全部"),
                  CATEGORIES.filter((c) => catCounts[c.id]).map((c) =>
                    h("button", {
                      key: c.id, type: "button",
                      className: "urt-cat-chip" + (catFilter === c.id ? " active" : ""),
                      onClick: () => setCatFilter(catFilter === c.id ? null : c.id)
                    }, c.name + " " + catCounts[c.id])
                  )
                )
              : null,
            mode === "settings"
              ? settingsPane
              : (items.length
                  ? h("ul", { className: "urt-list" }, listItems)
                  : h("div", { className: "urt-empty" },
                      query || catFilter ? "没有匹配的记录" : EMPTY_TEXT[mode],
                      query || catFilter
                        ? h("div", { className: "urt-empty-hint" }, "可以清空搜索框，或在分类条点「全部」")
                        : null
                    )),
            toastMsg ? h("div", { className: "urt-toast" }, toastMsg) : null,
            h("div", { className: "urt-foot" },
              h("span", { className: "urt-foot-note" }, "DSH 内点击自动记录 · 已整合本机 Edge 历史 · 拖动标题栏移动窗口"),
              h("button", {
                type: "button",
                className: "urt-clear",
                onClick: () => {
                  if (window.confirm("清空全部网址记录（含收藏）？此操作不可恢复。") &&
                      window.confirm("再次确认：真的要清空吗？")) clearAll();
                }
              }, "清空记录")
            )
          )
        ),
        document.body
      );
    }

    /* ================= 聊天输入栏工具行按钮（原侧边栏位置被聊天页覆盖，迁移至此） ================= */

    function SidebarButton({ wide, variant }) {
      const [, bump] = react.useReducer((x) => x + 1, 0);
      const [open, setOpen] = react.useState(false);
      const [tip, setTip] = react.useState(null);
      const btnRef = react.useRef(null);
      react.useEffect(() => onStoreChange(bump), []);
      const count = totalCount();

      const showTip = () => {
        const el = btnRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!r || r.width === 0) return;
        setTip({
          title: "网址足迹",
          sub: "你从 DSH 打开过的网址都会自动记录在这里" + (count > 0 ? "（已记录 " + count + " 个）" : "，点击查看常用 / 最近 / 收藏。"),
          x: Math.min(Math.max(r.left + r.width / 2, 130), (window.innerWidth || 1200) - 130),
          y: Math.max(r.top - 10, 46)
        });
      };
      const hideTip = () => setTip(null);

      return h("div", { className: "urt-button-wrap" + (variant === "composer" ? " urt-button-wrap-composer" : "") },
        h("button", {
          ref: btnRef,
          type: "button",
          className: "urt-button" + (variant === "composer" ? " urt-button-composer" : ""),
          title: "网址足迹 — 你从 DSH 打开过的网址",
          "aria-label": "网址足迹",
          onClick: () => setOpen((v) => !v),
          onMouseEnter: showTip,
          onMouseLeave: hideTip,
          onFocus: showTip,
          onBlur: hideTip
        },
          h("span", { className: "urt-button-icon", dangerouslySetInnerHTML: { __html: ICONS.clock } }),
          wide ? h("span", { className: "urt-button-label" }, "网址足迹") : null,
          count > 0 && variant !== "composer"
            ? h("span", { className: "urt-button-badge" }, count > 999 ? "999+" : String(count))
            : null
        ),
        tip
          ? react_dom.createPortal(
              h("div", {
                className: "dsh-plugin-tip",
                role: "status",
                style: { left: tip.x + "px", top: tip.y + "px" }
              },
                h("div", { className: "dsh-plugin-tip-title" }, tip.title),
                h("div", { className: "dsh-plugin-tip-sub" }, tip.sub)),
              document.body
            )
          : null,
        open ? h(Panel, { onClose: () => setOpen(false) }) : null
      );
    }

    /* ================= 样式 ================= */

    const CSS = `
.urt-button {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #6b7280);
  border-radius: 8px;
  cursor: pointer;
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
}
.urt-button:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12));
  color: var(--dsw-alias-label-primary, #1f2937);
}
.urt-button-icon { display: inline-flex; flex: none; }
.urt-button-label {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.urt-button-badge {
  flex: none;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--dsw-static-deepseek-500, #4f46e5);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  box-sizing: border-box;
}
.urt-overlay {
  position: fixed;
  inset: 0;
  z-index: 9997;
  background: rgba(10, 14, 24, 0.28);
}
.urt-panel {
  position: absolute;
  top: 64px;
  right: 24px;
  width: 400px;
  max-width: calc(100vw - 32px);
  max-height: min(72vh, 640px);
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2937);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
  overflow: hidden;
  font-size: 13px;
}
.urt-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 14px 10px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  cursor: grab;
  touch-action: none;
}
.urt-head:active { cursor: grabbing; }
.urt-panel.urt-dragging { user-select: none; }
.urt-panel.urt-dragging .urt-head { cursor: grabbing; }
.urt-head-title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 700;
}
.urt-head-icon { display: inline-flex; color: var(--dsw-static-deepseek-500, #4f46e5); }
.urt-head-right { display: inline-flex; align-items: center; gap: 8px; }
.urt-head-count { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b7280); }
.urt-iconbtn {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #6b7280);
  border-radius: 7px;
  cursor: pointer;
}
.urt-iconbtn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); color: var(--dsw-alias-label-primary, #1f2937); }
.urt-search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 12px 0;
  padding: 7px 10px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 9px;
  background: var(--dsw-alias-bg-layer-1, #f7f8fa);
}
.urt-search-icon { display: inline-flex; color: var(--dsw-alias-label-secondary, #9ca3af); flex: none; }
.urt-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--dsw-alias-label-primary, #1f2937);
  font-size: 13px;
  font-family: inherit;
}
.urt-tabs { display: flex; gap: 4px; padding: 10px 12px 6px; }
.urt-tab {
  flex: 1;
  padding: 5px 0;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-size: 12.5px;
  font-family: inherit;
  cursor: pointer;
  border-radius: 7px;
}
.urt-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.10)); }
.urt-tab.active { color: var(--dsw-static-deepseek-500, #4f46e5); font-weight: 700; background: var(--dsw-static-deepseek-50, #eef0ff); }
.urt-list {
  list-style: none;
  margin: 0;
  padding: 4px 8px;
  overflow-y: auto;
  flex: 1;
  min-height: 120px;
}
.urt-row { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-radius: 9px; }
.urt-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08)); }
.urt-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 9px; text-decoration: none; color: inherit; }
.urt-avatar {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  color: #fff;
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.urt-texts { min-width: 0; display: flex; flex-direction: column; }
.urt-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
.urt-meta { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b7280); white-space: nowrap; overflow: hidden; display: flex; gap: 4px; align-items: center; }
.urt-host { overflow: hidden; text-overflow: ellipsis; }
.urt-ops { display: flex; gap: 2px; flex: none; opacity: 0; transition: opacity 0.12s; }
.urt-row:hover .urt-ops { opacity: 1; }
.urt-op {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #9ca3af);
  border-radius: 7px;
  cursor: pointer;
}
.urt-op:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); color: var(--dsw-static-deepseek-500, #4f46e5); }
.urt-op.on { color: #f5a623; }
.urt-op.on:hover { color: #f5a623; }
.urt-empty { padding: 28px 16px; text-align: center; color: var(--dsw-alias-label-secondary, #9ca3af); }
.urt-empty-hint { font-size: 11.5px; margin-top: 6px; opacity: 0.85; }
.urt-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
}
.urt-foot-note { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #9ca3af); }
.urt-src {
  flex: none;
  font-size: 10px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 99px;
  background: var(--dsw-alias-bg-overlay, rgba(127, 127, 127, 0.15));
  color: var(--dsw-alias-label-secondary, #8a90a3);
}
.urt-iconbtn.spinning svg { animation: urt-spin 0.8s linear infinite; }
@keyframes urt-spin { to { transform: rotate(360deg); } }
.urt-edge-error {
  margin: 8px 14px 0;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: #b45309;
  background: rgba(245, 158, 11, 0.12);
}
.urt-tags { display: flex; align-items: center; gap: 4px; flex: none; }
.urt-cat-wrap { position: relative; display: inline-flex; }
.urt-cat-tag {
  border: none;
  border-radius: 99px;
  padding: 1px 7px;
  font-size: 10.5px;
  line-height: 1.5;
  cursor: pointer;
  font-family: inherit;
}
.urt-cat-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 50;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 9px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
  padding: 4px;
  min-width: 92px;
}
.urt-cat-item {
  border: none;
  background: none;
  text-align: left;
  padding: 5px 9px;
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  color: var(--dsw-alias-label-primary, #1f2937);
  cursor: pointer;
}
.urt-cat-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.urt-cats { display: flex; flex-wrap: wrap; gap: 5px; padding: 8px 12px 4px; }
.urt-cat-chip {
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: none;
  border-radius: 99px;
  padding: 2px 9px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  font-family: inherit;
}
.urt-cat-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.10)); }
.urt-cat-chip.active { background: var(--dsw-static-deepseek-500, #4f46e5); border-color: transparent; color: #fff; }
.urt-cat-chip.off { opacity: 0.45; text-decoration: line-through; }
.urt-settings { padding: 10px 14px; overflow-y: auto; flex: 1; font-size: 13px; }
.urt-set-row { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
.urt-set-row input[type="checkbox"] { accent-color: var(--dsw-static-deepseek-500, #4f46e5); }
.urt-set-num {
  width: 58px;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, #f7f8fa);
  color: var(--dsw-alias-label-primary, #1f2937);
  font-family: inherit;
}
.urt-set-col { flex-direction: column; align-items: flex-start; gap: 8px; }
.urt-set-label { color: var(--dsw-alias-label-secondary, #6b7280); font-size: 12.5px; }
.urt-set-chips { display: flex; flex-wrap: wrap; gap: 5px; }
.urt-set-actions { display: flex; gap: 10px; margin: 14px 0 6px; }
.urt-clear:disabled { opacity: 0.45; cursor: default; }
.urt-set-note {
  color: var(--dsw-alias-label-secondary, #9ca3af);
  font-size: 12px;
  line-height: 1.7;
  border-top: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  padding-top: 10px;
  margin-top: 6px;
}
.urt-toast {
  position: absolute;
  left: 50%;
  bottom: 46px;
  transform: translateX(-50%);
  background: var(--dsw-alias-label-primary, #1f2937);
  color: var(--dsw-alias-bg-layer-2, #ffffff);
  padding: 7px 14px;
  border-radius: 10px;
  font-size: 12.5px;
  z-index: 60;
  pointer-events: none;
  white-space: nowrap;
  max-width: 90%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.urt-clear {
  border: none;
  background: none;
  color: var(--dsw-alias-label-secondary, #9ca3af);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 7px;
}
.urt-clear:hover { color: #dc2626; background: rgba(220, 38, 38, 0.08); }

/* ============ 精简重设计（2026）：留白 + 细线 + 单一强调色 ============ */
.urt-overlay { animation: urt-fade-in 0.22s ease-out; }
.urt-panel {
  border-radius: 18px;
  box-shadow: 0 18px 50px rgba(10, 16, 30, 0.28);
  animation: urt-panel-in 0.3s cubic-bezier(0.22, 1.2, 0.36, 1);
}
@keyframes urt-fade-in { from { opacity: 0; } }
@keyframes urt-panel-in {
  from { opacity: 0; transform: translateY(10px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.urt-head { padding: 14px 16px 12px; }
.urt-head-title { font-size: 15px; }
.urt-head-count {
  background: var(--dsw-alias-bg-overlay, rgba(127, 127, 127, 0.12));
  border-radius: 99px;
  padding: 2px 10px;
  font-weight: 600;
}
.urt-iconbtn { width: 28px; height: 28px; border-radius: 8px; }
.urt-search { margin: 12px 14px 0; border-radius: 11px; padding: 9px 12px; }
.urt-tabs { padding: 10px 10px 4px; gap: 6px; }
.urt-tab { border-radius: 9px; padding: 7px 0; }
.urt-tab.active { font-weight: 600; }
.urt-cats { padding: 6px 12px 2px; gap: 6px; }
.urt-cat-chip {
  border: none;
  background: var(--dsw-alias-bg-overlay, rgba(127, 127, 127, 0.1));
  color: var(--dsw-alias-label-secondary, #6b7280);
  padding: 3px 10px;
  font-size: 11.5px;
}
.urt-cat-chip:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.14)); }
.urt-cat-chip.active { background: var(--dsw-static-deepseek-500, #4f46e5); color: #fff; }
.urt-list { padding: 6px 8px 10px; }
.urt-row { padding: 8px 10px; border-radius: 10px; }
.urt-row:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.08)); }
.urt-avatar { width: 28px; height: 28px; border-radius: 8px; font-size: 12.5px; }
.urt-title { font-size: 13.5px; }
.urt-meta { font-size: 12px; gap: 5px; }
.urt-src {
  width: 7px; height: 7px;
  border-radius: 50%;
  padding: 0;
  font-size: 0;
  background: var(--dsw-alias-label-secondary, #8a90a3);
  opacity: 0.55;
  flex: none;
}
.urt-cat-tag { font-size: 10px; padding: 2px 8px; opacity: 0.9; }
.urt-cat-menu { border-radius: 10px; padding: 5px; }
.urt-foot { padding: 10px 16px; }
.urt-foot-note { font-size: 11.5px; }
.urt-empty { padding: 32px 16px; }
.urt-toast { border-radius: 12px; }

/* ============ 高级感 v2：玻璃拟态 · 发丝描边 · 慢动画 ============ */
.urt-overlay { background: rgba(13, 22, 34, 0.42); backdrop-filter: blur(7px); }
.urt-panel {
  border-radius: 20px;
  border: 1px solid rgba(148, 178, 208, 0.30);
  background: linear-gradient(160deg, rgba(250, 252, 255, 0.84), rgba(238, 246, 253, 0.70));
  backdrop-filter: blur(28px) saturate(1.25);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.7) inset,
    0 22px 60px rgba(23, 49, 79, 0.24),
    0 4px 16px rgba(23, 49, 79, 0.10);
  animation: urt-panel-in 0.5s cubic-bezier(0.16, 1, 0.3, 1);
}
body[data-ds-dark-theme] .urt-panel {
  border-color: rgba(255, 255, 255, 0.10);
  background: linear-gradient(160deg, rgba(26, 40, 57, 0.86), rgba(15, 24, 36, 0.80));
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 22px 60px rgba(0, 0, 0, 0.55);
}

/* 头部：渐变发丝线 + 渐变标题字 */
.urt-head { padding: 16px 18px 14px; border-bottom: none; position: relative; }
.urt-head::after {
  content: "";
  position: absolute;
  left: 18px; right: 18px; bottom: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(120, 150, 185, 0.38), transparent);
}
.urt-head-title {
  font-size: 14.5px;
  font-weight: 700;
  letter-spacing: 0.05em;
  background: linear-gradient(120deg, #2c5a80, #4a8fbe);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
body[data-ds-dark-theme] .urt-head-title {
  background: linear-gradient(120deg, #cfe3f2, #77aed6);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.urt-head-count {
  background: rgba(120, 150, 185, 0.14);
  color: var(--dsw-alias-label-secondary, #6b7280);
  font-weight: 600;
  letter-spacing: 0.03em;
}
.urt-iconbtn { opacity: 0.75; }
.urt-iconbtn:hover { opacity: 1; }

/* 搜索：内阴影 + 聚焦光环 */
.urt-search {
  margin: 14px 16px 0;
  border-radius: 13px;
  padding: 9px 13px;
  border: 1px solid rgba(148, 178, 208, 0.26);
  background: rgba(255, 255, 255, 0.55);
  box-shadow: inset 0 1px 2px rgba(23, 49, 79, 0.05);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
body[data-ds-dark-theme] .urt-search { background: rgba(255, 255, 255, 0.05); }
.urt-search:focus-within { border-color: rgba(74, 143, 190, 0.55); box-shadow: 0 0 0 3px rgba(74, 143, 190, 0.12); }

/* 分段控件（tab）：容器化 + 白色悬浮块 */
.urt-tabs {
  margin: 12px 16px 0;
  padding: 4px;
  gap: 4px;
  background: rgba(120, 150, 185, 0.13);
  border-radius: 13px;
}
.urt-tab { border-radius: 9px; padding: 7px 0; font-weight: 500; }
.urt-tab:hover { background: rgba(120, 150, 185, 0.1); }
.urt-tab.active {
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2937);
  font-weight: 600;
  box-shadow: 0 1px 4px rgba(23, 49, 79, 0.16);
}
body[data-ds-dark-theme] .urt-tabs { background: rgba(255, 255, 255, 0.06); }
body[data-ds-dark-theme] .urt-tab.active { background: rgba(255, 255, 255, 0.12); color: var(--dsw-alias-label-primary, #f3e3ee); }

/* 分类条：更轻 */
.urt-cats { padding: 8px 16px 2px; gap: 6px; }
.urt-cat-chip { border-radius: 99px; padding: 3px 11px; font-size: 11.5px; font-weight: 500; letter-spacing: 0.02em; }
.urt-cat-chip.active { background: linear-gradient(135deg, #3d6f96, #2c5a80); box-shadow: 0 3px 10px rgba(44, 90, 128, 0.35); }
body[data-ds-dark-theme] .urt-cat-chip.active { background: linear-gradient(135deg, #5b93ba, #3d6f96); }

/* 列表行：白玻璃 + 悬停轻浮 */
.urt-list { padding: 8px 10px 12px; }
.urt-row {
  padding: 9px 12px;
  border-radius: 12px;
  border: 1px solid transparent;
  transition: background 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
}
.urt-row:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.07));
  border-color: rgba(148, 178, 208, 0.18);
  box-shadow: 0 4px 14px rgba(23, 49, 79, 0.08);
}
.urt-avatar {
  width: 30px; height: 30px;
  border-radius: 10px;
  font-size: 13px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 1px 3px rgba(23, 49, 79, 0.18);
}
.urt-title { font-size: 13.5px; font-weight: 600; letter-spacing: 0.01em; }
.urt-meta { font-size: 11.5px; letter-spacing: 0.02em; }

/* 页脚：渐变发丝线 */
.urt-foot { padding: 11px 18px; border-top: none; position: relative; }
.urt-foot::before {
  content: "";
  position: absolute;
  left: 18px; right: 18px; top: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(120, 150, 185, 0.38), transparent);
}
.urt-toast {
  background: rgba(20, 30, 45, 0.92);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #e8f0f8;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}

/* ============ 设计感 v3：分组与层级 ============ */
.urt-sec-label {
  list-style: none;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--dsw-alias-label-secondary, #6b7280);
  padding: 12px 12px 5px;
  opacity: 0.8;
}
.urt-set-group {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--dsw-alias-label-secondary, #6b7280);
  margin: 16px 0 8px;
  padding-top: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2, #eef0f4);
}
.urt-set-group:first-child { margin-top: 0; padding-top: 0; border-top: none; }
.urt-set-actions { margin-top: 18px; }

/* ============ 颜色还原：回到主题色（新版式保留） ============ */
.urt-overlay { background: rgba(10, 14, 24, 0.30); backdrop-filter: blur(2px); }
.urt-panel {
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22);
}
.urt-head-title, body[data-ds-dark-theme] .urt-head-title {
  background: none;
  color: var(--dsw-alias-label-primary, #1f2937);
  -webkit-text-fill-color: var(--dsw-alias-label-primary, #1f2937);
}
.urt-head-count {
  background: var(--dsw-alias-bg-overlay, rgba(127, 127, 127, 0.14));
  color: var(--dsw-alias-label-secondary, #6b7280);
}
.urt-search {
  background: var(--dsw-alias-bg-layer-1, #f7f8fa);
  border-color: var(--dsw-alias-border-l2, #e5e7eb);
}
.urt-tabs { background: var(--dsw-alias-bg-overlay, rgba(127, 127, 127, 0.12)); }
body[data-ds-dark-theme] .urt-tabs { background: var(--dsw-alias-bg-overlay, rgba(127, 127, 127, 0.2)); }
.urt-tab.active {
  background: var(--dsw-static-deepseek-50, #eef0ff);
  color: var(--dsw-static-deepseek-500, #4f46e5);
  box-shadow: none;
}
body[data-ds-dark-theme] .urt-tab.active {
  background: var(--dsw-static-deepseek-50, #eef0ff);
  color: var(--dsw-static-deepseek-500, #4f46e5);
}
.urt-cat-chip.active {
  background: var(--dsw-static-deepseek-500, #4f46e5);
  box-shadow: none;
}
body[data-ds-dark-theme] .urt-cat-chip.active { background: var(--dsw-static-deepseek-500, #4f46e5); }
.urt-toast {
  background: var(--dsw-alias-label-primary, #1f2937);
  color: var(--dsw-alias-bg-layer-2, #ffffff);
  border: none;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
}

/* ============ 大气版：更宽更高、更舒展 ============ */
.urt-panel { width: 460px; max-width: calc(100vw - 32px); border-radius: 22px; }
.urt-head { padding: 18px 20px 16px; }
.urt-head-title { font-size: 16.5px; }
.urt-head-count { padding: 3px 11px; font-size: 12px; }
.urt-iconbtn { width: 30px; height: 30px; }
.urt-search { margin: 16px 18px 0; padding: 11px 14px; border-radius: 14px; }
.urt-tabs { margin: 14px 18px 0; border-radius: 14px; padding: 5px; }
.urt-tab { padding: 8px 0; font-size: 13px; }
.urt-cats { padding: 10px 18px 2px; }
.urt-list { padding: 10px 12px 14px; }
.urt-row { padding: 12px 14px; gap: 8px; border-radius: 14px; }
.urt-avatar { width: 36px; height: 36px; border-radius: 11px; font-size: 15px; }
.urt-title { font-size: 14.5px; }
.urt-meta { font-size: 12.5px; }
.urt-ops { gap: 4px; }
.urt-op { width: 28px; height: 28px; }
.urt-foot { padding: 13px 20px; }
.urt-foot-note { font-size: 12px; }
.urt-empty { padding: 40px 20px; }

/* ============ 可互动性：搜索一键清空 ============ */
.urt-search { position: relative; }
.urt-search-clear {
  position: absolute;
  right: 9px; top: 50%;
  transform: translateY(-50%);
  width: 22px; height: 22px;
  border: none;
  background: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--dsw-alias-label-secondary, #9ca3af);
  cursor: pointer;
}
.urt-search-clear:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.urt-search-input { padding-right: 28px; }

/* 侧边栏按钮防溢出（避免被聊天页盖住） */
.urt-button-wrap { position: relative; z-index: 40; }
.urt-button { min-width: 0; max-width: 100%; box-sizing: border-box; }

/* 聊天输入栏工具行按钮（新家：紧凑图标按钮） */
.urt-button-wrap-composer { position: relative; }
.urt-button-composer {
  width: auto;
  min-width: 36px;
  height: 36px;
  padding: 6px;
  justify-content: center;
  border-radius: 10px;
}
.urt-button-composer .urt-button-icon svg { width: 20px; height: 20px; }

/* ============ 统一的悬停提示气泡（三个插件共用） ============ */
.dsh-plugin-tip {
  position: fixed;
  z-index: 10001;
  max-width: 270px;
  padding: 10px 14px;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  color: var(--dsw-alias-label-primary, #1f2937);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(23, 49, 79, 0.28);
  font-size: 12.5px;
  line-height: 1.55;
  text-align: left;
  pointer-events: none;
  transform: translate(-50%, -100%);
  animation: dsh-tip-in 0.15s ease-out;
}
.dsh-plugin-tip::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -5.5px;
  width: 10px;
  height: 10px;
  background: var(--dsw-alias-bg-layer-2, #ffffff);
  border-right: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  transform: translateX(-50%) rotate(45deg);
}
.dsh-plugin-tip-title { font-weight: 700; font-size: 13px; }
.dsh-plugin-tip-sub { margin-top: 3px; color: var(--dsw-alias-label-secondary, #6b7280); }
@keyframes dsh-tip-in {
  from { opacity: 0; transform: translate(-50%, calc(-100% - 5px)); }
  to { opacity: 1; transform: translate(-50%, -100%); }
}
`;

    /* ================= 插件入口 ================= */

    const inject = ["slots"];

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-url-trace";
        style.dataset.pluginCss = "dsh-url-trace/style.css";
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => { if (style.isConnected) style.remove(); };
      }, "url-trace: styles");

      // 记录：捕获从 DSH 页面打开的链接 + window.open
      ctx.effect(() => {
        const onClick = (e) => {
          if (e.defaultPrevented) return;
          const target = e.target;
          if (!(target instanceof Element)) return;
          const link = target.closest("a[href]");
          if (!link) return;
          const raw = link.getAttribute("href") || link.href || "";
          if (!raw) return;
          const title = (link.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300);
          recordVisit(raw, title);
        };
        const origOpen = window.open;
        window.open = function (...args) {
          try {
            recordVisit(String(args[0] || ""), "");
          } catch (e) { /* ignore */ }
          return origOpen.apply(this, args);
        };
        document.addEventListener("click", onClick, true);
        document.addEventListener("auxclick", onClick, true);
        return () => {
          document.removeEventListener("click", onClick, true);
          document.removeEventListener("auxclick", onClick, true);
          window.open = origOpen;
        };
      }, "url-trace: click recorder");

      // 侧边栏底部区域在展开/收起状态下都会被聊天页盖住 → 按钮迁到聊天输入栏工具行
      ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
        name: "conversation.input.left",
        id: "dsh-url-trace.view",
        order: 0
      }, (props) => h(SidebarButton, Object.assign({}, props || {}, { variant: "composer" }))));
    }

    exports.apply = apply;
    exports.inject = inject;
    // 仅用于本地模拟测试（mock-boot.cjs）
    exports.__test = {
      mergedEntries,
      recordVisit,
      togglePin,
      isPinned,
      removeEntry,
      ruleCategory,
      categoryOf,
      autoPin,
      undoOrganize,
      clearCategoryCache,
      clampPanel,
      normalizeUrl,
      dedupKey,
      getStore: () => store
    };
    return module.exports;
  }
});
