import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // CI 上 PGlite 初始化/迁移较慢，默认 5s 会超时
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
