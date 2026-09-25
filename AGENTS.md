# AGENTS.md — 给在本仓库工作的 AI / 开发者

先读 [docs/product-plan.md](docs/product-plan.md)（产品方向、现状、路线图），再读 README（怎么跑）。

## 结构与约定

- npm workspaces，TypeScript 全栈：`apps/server`（Hono + Drizzle）、`apps/web`（React + antd + React Query）、`apps/extension`（Chrome MV3）、`packages/shared`（三端共享类型与 1688 解析）、`shopify-app`（Shopify 应用配置，CLI 部署）。
- 服务端依赖通过 `Deps` 注入（`src/context.ts`）；测试用内存 PGlite + `test/fakeShopify.ts`，不连真实服务。改服务端逻辑必须补测试：`npm test`。
- 所有业务数据按 `workspace_id` 隔离；新接口必须在查询里带 workspace 条件，并写跨团队访问测试。
- 平台差异只写在 `src/channels/<platform>/` 的 `ChannelAdapter` 实现里。
- 慢操作（发布、图片、同步、以后的 AI）走 `jobs` 队列，不要在请求里同步调用外部平台。

## 已踩过的坑（别再踩）

1. **改了 `db/schema.ts`**：`npm run db:generate -w @caiji/server` 生成迁移后要**手动重启 dev:server**。迁移只在启动时执行，`tsx watch` 不会因为新迁移文件重启，否则新表不存在、接口报 500。
2. **1688 页面数据**：详情页现在是 `window.context=(function…)(window.contextPath,{…})`，是 JS 对象字面量（有 `{98:"…"}` 这种裸键），用 `parseLooseJson`，**永远不要在服务端 eval 页面内容**。
3. **隐私**：1688 页面数据里有**当前浏览者自己的 1688 账号**（buyerModel）。发往服务端前必须用 `productOnlyData()` 裁剪；解析成功时不上传整页 HTML。
4. **插件在 1688 页面注入 UI**：1688 的商品卡片整个是 `<a target=_blank>`，页面脚本会抢先处理点击。按钮必须放在我们自己的 Shadow DOM 浮层里再定位到卡片上，**不要插进 1688 的 DOM**。
5. **Shopify 重复发布**：`productSet` 只在首次创建时设 `status`，之后不要覆盖（商家可能在 Shopify 里改回了草稿）；远端已删除的商品重新发布要按新建处理。
6. **Shopify 图片**：不要把 1688 图片地址直接给 Shopify。用我们存储里的副本走 `stagedUploadsCreate`，发布后检查媒体处理状态。
7. **Windows 开发机**：Vite 需绑定 `127.0.0.1`（`localhost` 可能只解析到 IPv6）；Bash 工具里写含引号 / 反斜杠的文件时，heredoc 容易被转义坏，改用编辑工具写文件。
8. **密钥**：不要把任何 token / secret 写进代码、提交记录或对话；店铺凭据只经由 UI 加密入库，R2 等凭据由用户自己填进 `apps/server/.env`。

## 验证方式

- 服务端：`npm test`、`npm run typecheck`
- 插件：`npm run build:ext` 后需要用户在 `chrome://extensions` 里点刷新；可以用 Claude in Chrome 在用户的浏览器里实测 1688 页面
- 端到端：工作台 http://localhost:5173 ；发布结果可以用 Shopify connector 核对
