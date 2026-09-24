# caiji-saas

跨平台货源采集 + AI 刊登 SaaS（MVP 骨架）。

```
apps/extension   Chrome MV3 插件：在 1688 商品页一键采集 → POST 到服务端
apps/server      Hono API：商品库（JSONL 持久化），后续接 AI 管线与平台 API
apps/web         Vite + React 工作台：商品库浏览、AI 处理/刊登入口（占位）
packages/shared  插件 ↔ 服务端共享类型（CollectedOffer / Product）
```

## 开发

```bash
npm install
npm run dev:server    # http://localhost:3000
npm run dev:web       # http://localhost:5173（/api 代理到 3000）
npm run build:ext     # 产出 apps/extension/dist，chrome://extensions 加载
```

## 路线图

1. **采集**：1688 offer 页 → `CollectedOffer`（已实现：插件 content script 解析页面内嵌 JSON + DOM 兜底）
2. **AI 管线**：翻译、标题/描述重写、图片 OCR 换字、敏感词过滤
3. **刊登**：先接 Shopify Admin API（最友好、无平台规则），再申请 Shopee/TikTok 开放平台
4. **订单回流**：平台订单 → 货源采购 → 回填运单（后期接货代）

> 合规提示：采集刊登请优先对接授权货源（1688 跨境专供、一件代发供应链），直接搬运他人店铺商品在多数平台属违规行为。
