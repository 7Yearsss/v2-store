import { cpSync } from "node:fs";
import { build } from "esbuild";

const common = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
};

await build({
  ...common,
  entryPoints: {
    content: "src/content.ts",
    background: "src/background.ts",
    "collect1688-main": "src/main-world/1688.ts",
    "site-bridge": "src/site-bridge.ts",
    search: "src/search.ts",
  },
});
cpSync("static", "dist", { recursive: true });
console.log("extension built -> dist/");
