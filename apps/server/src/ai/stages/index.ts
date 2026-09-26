import type { StoreRow } from "../../channels/types.js";
import type { Deps } from "../../context.js";
import { categorySuggestStage } from "./categorySuggest.js";
import { enhanceStage } from "./enhance.js";
import { loadStageRow, type Stage } from "./types.js";

export {
  loadStageRow,
  replaceStageSuggestions,
  type SourceItemRow,
  type Stage,
  type StageContext,
  type StageProposal,
} from "./types.js";

/** 注册表：顺序即执行顺序。新 stage（确定性规则、视频脚本…）加在这里。 */
export const STAGES: Stage[] = [enhanceStage, categorySuggestStage];

/** 店铺启用中的 stage（disabledStages 剔除）。 */
export function enabledStages(store: StoreRow): Stage[] {
  const disabled = new Set(store.rules?.pipeline?.disabledStages ?? []);
  return STAGES.filter((s) => !disabled.has(s.key));
}

/** AI 是否真的会跑（店铺开关 + 服务端配置都开）。 */
export function aiEnabled(deps: Deps, store: StoreRow): boolean {
  return store.aiEnhance !== "off" && !!deps.config.ai;
}

/**
 * stage 注册表入口：listing.aiEnhance job 调它跑全部启用 stage；
 * opts.only 限定单 stage（兼容旧 listing.categorySuggest job 与单点重跑）。
 * 店铺关 AI 或未配 AI 时整个跳过（链路里仍会继续走 advance）。
 */
export async function runStages(
  deps: Deps,
  listingId: string,
  opts: { only?: string } = {},
) {
  const row = await loadStageRow(deps, listingId);
  if (!aiEnabled(deps, row.store)) return;
  for (const stage of enabledStages(row.store)) {
    if (opts.only && stage.key !== opts.only) continue;
    await stage.run({ deps, ...row });
  }
}
