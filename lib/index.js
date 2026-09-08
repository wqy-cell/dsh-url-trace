// dsh-url-trace — host half.
// 提供两个本地接口：
//   GET  /url-trace/edge-history  读取本机 Edge 浏览器历史（缓存 60 秒）
//   POST /url-trace/categorize    用 DSH 默认模型对网址批量分类（LLM 兜底）
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const name = "url-trace";
export const inject = ["webServer"];

/** Chromium 时间戳（自 1601-01-01 的微秒数）与 Unix 毫秒的差值。 */
const CHROMIUM_EPOCH_DELTA = 11644473600000;
const CACHE_TTL_MS = 60 * 1000;
const PER_PROFILE_LIMIT = 400;
const TOTAL_LIMIT = 500;
const CATEGORIZE_LIMIT = 40;

const CATEGORY_IDS = {
  "视频娱乐": "video",
  "社交社区": "social",
  "购物": "shopping",
  "技术开发": "dev",
  "新闻资讯": "news",
  "学习教育": "study",
  "工具AI": "tools",
  "搜索": "search",
  "其他": "other"
};

const CATEGORIZE_SYSTEM = [
  "你是网址分类助手。用户给你一批网站条目（url/title/host），请把每个网址归入以下类别之一：",
  "视频娱乐、社交社区、购物、技术开发、新闻资讯、学习教育、工具AI、搜索、其他。",
  "只输出一个 JSON 对象：键是条目里给出的完整 url 字符串，值是类别名。不要输出任何解释或多余文本。"
].join("");

let sqliteModulePromise = null;
function loadSqlite() {
  if (sqliteModulePromise === null) sqliteModulePromise = import("node:sqlite");
  return sqliteModulePromise;
}

function edgeUserDataDir() {
  return join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
}

/** 读取所有 Edge profile 的历史（聚合去重，按最近访问倒序，最多 TOTAL_LIMIT 条）。 */
async function readEdgeHistory() {
  const dir = edgeUserDataDir();
  if (!existsSync(dir)) return [];

  let profiles = [];
  try {
    profiles = readdirSync(dir).filter((d) => {
      try {
        return statSync(join(dir, d)).isDirectory() && existsSync(join(dir, d, "History"));
      } catch (e) { return false; }
    });
  } catch (e) { return []; }

  const sqlite = await loadSqlite();
  const { DatabaseSync } = sqlite;
  const entries = [];

  for (const prof of profiles) {
    const src = join(dir, prof, "History");
    const tmp = join(tmpdir(), "dsh-url-trace-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2));
    try {
      // 浏览器独占锁着原库：复制一份再读，读完整删掉
      copyFileSync(src, tmp);
      const db = new DatabaseSync(tmp, { readOnly: true });
      try {
        const rows = db.prepare(
          "SELECT url, title, visit_count, (last_visit_time / 1000 - " + CHROMIUM_EPOCH_DELTA + ") AS last_ts " +
          "FROM urls WHERE url LIKE 'http%' ORDER BY last_visit_time DESC LIMIT " + PER_PROFILE_LIMIT
        ).all();
        for (const r of rows) {
          if (!r || !r.url) continue;
          entries.push({
            url: String(r.url),
            title: String(r.title || ""),
            count: Number(r.visit_count) || 1,
            lastTs: Number(r.last_ts) || 0
          });
        }
      } finally {
        try { db.close(); } catch (e) { /* ignore */ }
      }
    } catch (e) {
      // 该 profile 读不了（被锁 / 损坏）→ 跳过，不影响其它 profile
    } finally {
      try { unlinkSync(tmp); } catch (e) { /* ignore */ }
    }
  }

  // 跨 profile 聚合：同 URL 次数相加、时间取最大
  const map = new Map();
  for (const e of entries) {
    const prev = map.get(e.url);
    if (prev) {
      prev.count += e.count;
      if (e.lastTs > prev.lastTs) { prev.lastTs = e.lastTs; prev.title = e.title || prev.title; }
    } else {
      map.set(e.url, { url: e.url, title: e.title, count: e.count, lastTs: e.lastTs });
    }
  }
  return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, TOTAL_LIMIT);
}

let cache = { at: 0, entries: [], error: null };

async function getEdgeHistory(force) {
  const now = Date.now();
  if (!force && cache.at > 0 && now - cache.at < CACHE_TTL_MS) return cache;
  try {
    const entries = await readEdgeHistory();
    cache = { at: now, entries, error: null };
  } catch (e) {
    cache = { at: now, entries: [], error: String((e && e.message) || e) };
  }
  return cache;
}

/* ================= LLM 分类 ================= */

/** 从模型输出中提取 JSON 对象并映射为 { url: categoryId }。 */
function parseCategoryJson(text, items) {
  const byUrl = new Map(items.map((i) => [i.url, i.url]));
  const results = {};
  let obj = null;
  try {
    const cleaned = String(text || "").replace(/```json|```/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) obj = JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) { obj = null; }
  if (!obj || typeof obj !== "object") return results;
  for (const [url, name] of Object.entries(obj)) {
    const id = CATEGORY_IDS[String(name || "")];
    if (id && byUrl.has(url)) results[url] = id;
  }
  return results;
}

/** 用 DSH 默认模型分类一批网址。服务不可用时返回带 error 的空结果。 */
async function categorizeWithLlm(ctx, items) {
  const llm = ctx.get("llm");
  const dm = ctx.get("agentDefaultModel");
  if (!llm || !dm) return { results: {}, error: "LLM 服务不可用" };
  let sel = null;
  try { sel = dm.source(); } catch (e) { /* ignore */ }
  if (!sel || !sel.provider || !sel.model) return { results: {}, error: "未配置默认模型" };
  try {
    const { createUserMessage } = await import("@deepseek-ai/dsh-llm");
    const message = createUserMessage({
      content: [{ type: "text", text: JSON.stringify(items.map((i) => ({ url: i.url, title: i.title || "", host: i.host || "" }))) }],
      source: { kind: "plugin", plugin: "dsh-url-trace" }
    });
    let text = "";
    for await (const chunk of llm.stream({
      provider: sel.provider,
      model: sel.model,
      system: CATEGORIZE_SYSTEM,
      messages: [message],
      maxTokens: 1500,
      temperature: 0
    })) {
      if (chunk && chunk.type === "text-delta") text += chunk.text;
    }
    return { results: parseCategoryJson(text, items), error: null };
  } catch (e) {
    return { results: {}, error: String((e && e.message) || e) };
  }
}

/* ================= 路由 ================= */

async function readRequestBody(req, limitBytes) {
  let raw = "";
  let size = 0;
  for await (const chunk of req) {
    const piece = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    size += piece.length;
    if (size > limitBytes) throw new Error("body too large");
    raw += piece;
  }
  return raw;
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: "/url-trace",
    handler: async (req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      const send = (status, body) => {
        res.writeHead(status, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-cache"
        });
        res.end(body);
      };

      if (u.pathname === "/url-trace/edge-history") {
        if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
        const data = await getEdgeHistory(u.searchParams.get("force") === "1");
        send(200, JSON.stringify({
          ok: data.error === null,
          generatedAt: data.at,
          error: data.error,
          entries: data.entries
        }));
        return;
      }

      if (u.pathname === "/url-trace/categorize") {
        if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
        let payload = null;
        try {
          payload = JSON.parse(await readRequestBody(req, 64 * 1024));
        } catch (e) {
          send(400, JSON.stringify({ ok: false, error: "bad request body" }));
          return;
        }
        const items = (Array.isArray(payload.items) ? payload.items : [])
          .filter((i) => i && typeof i.url === "string" && i.url)
          .slice(0, CATEGORIZE_LIMIT);
        if (items.length === 0) {
          send(200, JSON.stringify({ ok: true, results: {} }));
          return;
        }
        const out = await categorizeWithLlm(ctx, items);
        send(200, JSON.stringify({ ok: out.error === null, results: out.results, error: out.error }));
        return;
      }

      res.writeHead(404);
      res.end();
    }
  }), "url-trace: routes");
}
