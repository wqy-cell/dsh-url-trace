# dsh-url-trace · 网址足迹

一个 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）Web 客户端插件：**自动记录你从 DSH 页面打开过的每个网址**（点击链接 / `window.open`），在聊天输入栏提供随时查看的入口——常用排序、最近浏览、收藏置顶、即时搜索，代替浏览器历史记录与书签。

## 功能

- **自动记录**：捕获 DSH 页面内所有 `<a>` 链接点击（含新标签页打开）与 `window.open`；同一网址 10 分钟内重复打开只刷新时间、不重复计次
- **常用排序**：访问次数 × 时间衰减
- **收藏置顶**：行内 ★ 一键收藏，收藏始终排在「常用」最前
- **即时搜索**：标题 / 网址 / 域名
- **面板**：常用 / 最近 / 收藏 / 设置四个标签，点击行在新标签页打开、可删除单条、一键清空
- **自动整理（智能分类 + 自动收藏）**：常见网站由内置规则库即时分类；规则库不认识的网址交给 DSH 默认模型智能分类（每个网址仅一次，结果本地缓存）；达到次数与时间标准的常用网址自动收藏，可一键撤销
- **整合本机 Edge 历史**（仅 Windows）：面板可选合并本机 Edge 浏览器历史，跨来源去重
- **隐私**：数据只存本机浏览器 localStorage（上限各 2000 条）；除了可选的 LLM 智能分类请求（发给你的 DSH 模型服务）外，零网络请求；头像为域名首字母，不加载任何远程资源

## 安装

### 方式 A：从 GitHub 一键安装（推荐）

```powershell
dsh plugin --profile web add github:wqy-cell/dsh-url-trace
```

安装完成后重启 `dsh web`，刷新页面即可在聊天输入栏左侧看到 🕒 按钮。

### 方式 B：本地手动安装

1. 克隆/复制本仓库到 `<DSH_HOME>/profiles/web/plugins/dsh-url-trace/`
2. 在 web profile 的 `package.json` 增加依赖 `"dsh-url-trace": "file:./plugins/dsh-url-trace"`
3. `cordis.patch.yml` 增加：
   ```yaml
   - insert:
       - id: url-trace
         name: dsh-url-trace
   ```
4. 在 web profile 目录执行 `pnpm install`
5. 重启 `dsh web`，刷新页面

## 环境要求

- DSH Web profile（插件客户端 `dsh.client` 声明 `platform: web, immediately: true`）
- **Edge 历史整合**：仅 Windows 平台可用（读取本机 `%LOCALAPPDATA%\Microsoft\Edge\User Data`）；需要 Node.js ≥ 22（`node:sqlite`）。其它平台自动降级为仅记录 DSH 内点击，不影响其余功能
- LLM 智能分类：依赖你的 DSH 默认模型配置；模型不可用时降级为「其他」分类，不影响其余功能

## 权限与限制

- 只监听 DSH 页面内的点击事件与 `window.open`，不读取任何页面内容
- 仅记录 http/https 链接；浏览器地址栏输入、外部应用打开的网址不在范围内
- 数据与浏览器同源（默认 `127.0.0.1:3080`），换端口/换机器不迁移
- 开源代码**不包含任何个人数据**：无硬编码路径、无凭据、无日志；Edge 历史仅在运行时读取本机数据，不上传、不落地

## 结构

```
dsh-url-trace/
├── package.json        # dsh.client 声明（platform: web, immediately: true）
├── cordis.patch.yml    # dsh plugin add 使用的挂载声明
├── LICENSE             # MIT
├── lib/index.js        # host 半边（读 Edge 历史 + LLM 分类两个接口）
├── lib/client.js       # 浏览器半边（记录器 + 输入栏按钮 + 面板）
└── test/               # mock-boot.cjs（客户端 SSR 自测）· host-route.cjs（路由自测）· edge-read.cjs（Edge 库读取诊断）
```

## 开发者

客户端自测（模拟 DSH 环境 + 真实 react SSR）：

```powershell
node test/mock-boot.cjs
```

测试通过 `DSH_TEST_NODE_MODULES`（或 `DSH_HOME`，默认 `~/.dsh/profiles/node_modules`）定位 React 等真实依赖：

```powershell
$env:DSH_TEST_NODE_MODULES = "你的/dsh/profiles/node_modules"
node test/mock-boot.cjs
```

修改 `lib/client.js` 后无需重启，DSH 的 HMR 通道会自动热更新；修改 `lib/index.js`（host 路由）需要重启 `dsh web`。

## License

[MIT](./LICENSE)
