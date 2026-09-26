import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

/**
 * Web-app origins the extension trusts (site-bridge + API calls), comma
 * separated. Dev default is the Vite server, which proxies /api.
 *   EXT_APP_ORIGINS=https://app.example.com npm run build:ext
 */
const origins = (process.env.EXT_APP_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
for (const o of origins) {
  if (!/^https?:\/\/[^/]+$/.test(o)) throw new Error(`bad origin in EXT_APP_ORIGINS: ${o}`);
}

await build({
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  entryPoints: {
    content: "src/content.ts",
    background: "src/background.ts",
    "collect1688-main": "src/main-world/1688.ts",
    "site-bridge": "src/site-bridge.ts",
    list: "src/list.ts",
    offscreen: "src/offscreen.ts",
  },
});

cpSync("static", "dist", { recursive: true });
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
const patterns = origins.map((o) => `${o}/*`);
manifest.host_permissions.push(...patterns);
manifest.content_scripts.find((cs) => cs.js.includes("site-bridge.js")).matches = patterns;
writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));
console.log(`extension built -> dist/ (app origins: ${origins.join(", ")})`);
