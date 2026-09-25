---
name: testing-v2-store-collect
description: How to run and E2E-test the v2-store 1688 collect pipeline (extension + Hono server + Vite dashboard), including a fake-origin technique for when the source site anti-bots the machine's IP.
---

# Testing the v2-store collect pipeline

## Stack startup (verified 2026-09-25)
- API server: `npm run dev:server` (port 3000). Without DATABASE_URL it uses embedded PGlite at `apps/server/data/pglite` — `rm -rf apps/server/data/` (with the server stopped) for a clean run. Deps are hoisted to the repo-root `node_modules` (npm workspaces) — run `npm install` at repo root if missing. Server logic is covered by `npm test` (in-memory PGlite + fake Shopify); prefer that over manual E2E for server changes.
- Web dashboard: `npm run dev:web` (Vite, 127.0.0.1:5173, proxies /api to :3000).
- Auth (since 2026-09-25 rebuild): every API call needs a session. Register at http://localhost:5173/register, then click 右上角「授权插件」 — the web app mints an extension token and hands it to the extension via site-bridge (`SET_AUTH`). The extension then calls `${origin}/api/*` through the Vite proxy with `Authorization: Bearer`. Unauthorized extension → toast "插件未授权…".
- Simulating the extension from the dashboard tab: `fetch('/api/collect', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(harvest)})` uses the session cookie.
- Extension: `npm run build -w @caiji/extension` → `apps/extension/dist`. Source files may be newer than dist — always rebuild. Trusted web origins come from `EXT_APP_ORIGINS` at build time (default localhost/127.0.0.1:5173).
- Automation Chrome (CDP :29229) only auto-loads the adblock extension. To add ours WITHOUT the flaky GTK "Load unpacked" dialog: capture `/proc/<chrome-pid>/cmdline`, relaunch with the same flags and append `,/abs/path/to/dist` to `--load-extension` (comma-separated). Kill chrome with `pkill chrome` (NOT `pkill -f` — the pattern matches your own shell and kills it). Rebuild argv as a bash array from a one-arg-per-line file — `exec $(cat cmdline)` word-splits `--user-agent` into junk tabs.
- chrome://extensions needs Developer mode ON for unpacked loads; the running automation profile already has it.

## When 1688 anti-bots this IP (expected on datacenter IPs)
detail.1688.com serves an x5sec "punish" slider captcha and `login_jump` stubs; s.1688.com redirects to login.taobao.com; plain curl gets a 200 stub with no `__INIT_DATA`. The position-reveal slider ("release after N items fully appear") regenerates each attempt and is impractical via stepwise screenshots.

Workaround that exercises ALL extension+server code paths: serve faithful offer HTML from a local TLS server and map the hosts in Chrome:
1. Self-signed cert with SAN `detail.1688.com,s.1688.com,*.1688.com`; Node https server on :443 (`sudo setsid node server.js` — node is on the nvm path, give sudo the absolute path `/home/ubuntu/.nvm/versions/node/v24.19.0/bin/node`).
2. Chrome flags: `--host-resolver-rules=MAP detail.1688.com 127.0.0.1, MAP s.1688.com 127.0.0.1` and `--ignore-certificate-errors`.
3. Routes needed: `/offer/<digits>.html` (page with `window.__INIT_DATA = {globalData:{offerBaseInfo:{subject,imageList,offerId},skuModel:{skuProps,skuInfoMap},priceModel,productFeatureList,sellerLoginId}}`), a punish-lookalike `/offer/777777777.html` (text containing 安全验证/滑块/verifycode/punish), an offer page embedding `globalData.offerList` for 采集整店, and `/selloffer/offer_search.htm` with `<a href="https://detail.1688.com/offer/<id>.html">` links for 采集本页结果.
4. CLEAN UP AFTER: remove the two flags, relaunch Chrome, kill the fake server — otherwise the lead's browser silently collects fake data and `--ignore-certificate-errors` stays on.

## What to verify
- Detail page: orange 采集此商品 + 采集整店 buttons top-right; click → green toast (~4s lifetime — screenshot fast or verify server-side) → GET /api/source-items shows title/skus/images/attributes parsed server-side from pageContent.
- Reload → button reads "已采集 · 重新采集" via POST /api/collect/check {items:[{itemUrl}]}; a different itemUrl sharing the offerId also matches (offerId index).
- Re-collect → toast "已更新（重复采集）", same source-item id updated in place.
- Punish content on an /offer/ URL → red toast "失败: 页面出现安全验证，请通过验证后再采集", nothing stored.
- 采集整店 only works when offerList is in the page's own __INIT_DATA (or sniffed mtop cache on that same page) — window cache does NOT persist across navigations; otherwise honest error "未缓存到店铺商品列表".
- 采集本页结果 (s.1688.com only): scans offer links, each goes via background fetch (no CORS issues) → harvest → server.
- Dashboard: "插件已连接" badge via site-bridge PING (shows 「授权插件」 until authorized); 采集箱 table → 认领到店铺 → 刊登管理 → edit → 保存并发布.
- Failure path: unreachable/unparseable page → server 422 "页面未解析出商品数据" surfaced cleanly.

## Gotchas
- content.js injects only on path `/offer/*` — the real x5sec punish URL form `detail.1688.com//offer/<id>.html/_____tmd_____/punish` does NOT match, so no button/gate there; the validator only fires when punish content is served ON an /offer/ URL.
- Products API: POST /api/collect accepts harvest {sourceInfo,pageContent,productExtInfo} only (legacy normalized-offer path removed); POST /api/collect/check {items:[{itemUrl,itemId}]} → {collected:[itemUrls]}; both need auth.
- Toasts are ~4s — prefer verifying outcomes via GET /api/source-items (or the 采集箱 page).
- Devin Secrets needed: none for local E2E.
