import type { Db } from "./db/client.js";

export interface StudioConfig {
  /** 字段级 AI：配了走真 LLM（OpenAI 兼容 chat/completions），没配走确定性 mock。 */
  ai?: {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  /** mock 发布链路行为开关（测试/演示注入不同结果） */
  mock: {
    /** 发布延迟毫秒（异步感）；测试传 0 */
    publishDelayMs: number;
  };
}

export interface Deps {
  db: Db;
  config: StudioConfig;
  /** 单租户切片里的操作者标签（进 audit_logs.actor） */
  actor: string;
}

export type AppEnv = {
  Variables: { deps: Deps };
};
