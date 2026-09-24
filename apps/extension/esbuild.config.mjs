import { cpSync } from "node:fs";
import { build } from "esbuild";

const common = {
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
};

await build({ ...common, entryPoints: ["src/content.ts"] });
await build({ ...common, entryPoints: ["src/background.ts"] });
cpSync("static", "dist", { recursive: true });
console.log("extension built -> dist/");
