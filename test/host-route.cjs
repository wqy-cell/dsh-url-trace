// dsh-url-trace host 半边测试：注册路由并实际读取 Edge 历史
(async () => {
  const mod = await import("../lib/index.js");
  console.log("exports: " + Object.keys(mod).join(",") + " | inject: " + JSON.stringify(mod.inject));

  let route = null;
  const mockLlm = {
    stream: async function* () {
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: '{"https://x.example.com/a":"技术开发","https://y.example.com/b":"视频娱乐"}' };
      yield { type: "block-end", index: 0, block: { type: "text", text: "" } };
      yield { type: "finish", reason: "stop" };
    }
  };
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => name === "llm" ? mockLlm : name === "agentDefaultModel" ? { source: () => ({ provider: "mock", model: "mock" }) } : undefined,
    webServer: {
      register: (r) => { route = r; return () => {}; }
    }
  };
  mod.apply(ctx);
  console.log("route registered: " + (route ? route.kind + " " + route.path : "MISSING"));
  if (!route) process.exit(1);

  let status = 0, body = "";
  const res = {
    writeHead: (s) => { status = s; },
    end: (b) => { body = b; }
  };

  await route.handler({ method: "GET", url: "/url-trace/edge-history" }, res);
  console.log("status: " + status);
  const data = JSON.parse(body);
  console.log("ok: " + data.ok + " | entries: " + data.entries.length + " | error: " + data.error);
  if (data.entries.length > 0) {
    console.log("sample: " + JSON.stringify(data.entries.slice(0, 3)));
  }

  await route.handler({ method: "GET", url: "/url-trace/nope" }, res);
  console.log("404 case status: " + status);

  await route.handler({ method: "POST", url: "/url-trace/edge-history" }, res);
  console.log("405 case status: " + status);

  // categorize：带请求体的 POST，LLM 用 mock。
  // index.js 里动态 import("@deepseek-ai/dsh-llm") 是按自身文件 URL 解析的：
  // 从源码目录（不在任何 node_modules 树内）跑测试时解析不到，会误判成失败。
  // 这里探测一次，解析不到就明确跳过 LLM 路径的断言，而不是假装通过或假装失败。
  let llmPkgAvailable = true;
  try { await import("@deepseek-ai/dsh-llm"); } catch (e) { llmPkgAvailable = false; }

  const payload = JSON.stringify({
    items: [
      { url: "https://x.example.com/a", title: "", host: "x.example.com" },
      { url: "https://y.example.com/b", title: "视频", host: "y.example.com" }
    ]
  });
  const reqMock = {
    method: "POST",
    url: "/url-trace/categorize",
    [Symbol.asyncIterator]: async function* () { yield payload; }
  };
  await route.handler(reqMock, res);
  console.log("categorize status: " + status);
  const catData = JSON.parse(body);
  console.log("categorize ok: " + catData.ok + " | results: " + JSON.stringify(catData.results) + " | error: " + catData.error);
  const catOk = llmPkgAvailable
    ? (catData.ok &&
       catData.results["https://x.example.com/a"] === "dev" &&
       catData.results["https://y.example.com/b"] === "video")
    : true;
  if (!llmPkgAvailable) {
    console.log("SKIP: 解析不到 @deepseek-ai/dsh-llm（源码目录不在 node_modules 树内），categorize 的 LLM 路径未验证");
    console.log("      要验证请对运行中的服务打：curl -X POST http://127.0.0.1:3080/url-trace/categorize -H 'content-type: application/json' -d '{\"items\":[...]}'");
  }

  // categorize 无 LLM 服务 → 优雅降级
  let route2 = null;
  const ctx2 = {
    effect: (fn) => fn(),
    get: () => undefined,
    webServer: { register: (r) => { route2 = r; return () => {}; } }
  };
  mod.apply(ctx2);
  await route2.handler({ method: "POST", url: "/url-trace/categorize", [Symbol.asyncIterator]: async function* () { yield payload; } }, res);
  const catDeg = JSON.parse(body);
  console.log("degraded categorize ok: " + catDeg.ok + " | error: " + catDeg.error);

  process.exit(data.ok && data.entries.length > 0 && catOk && catDeg.ok === false ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
