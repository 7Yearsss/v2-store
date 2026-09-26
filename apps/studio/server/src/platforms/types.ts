import type { ChannelIssue, PlatformId } from "@studio/shared";
import type { Deps } from "../context.js";
import type { DraftRow, ProductRow, ShopRow } from "../db/schema.js";

/** 平台差异只写在这层：校验规则 + mock 发布 + 站点列表。
 *  新平台 = 一个新文件 + registry 里一行。 */
export interface PlatformAdapter {
  id: PlatformId;
  name: string;
  sites: string[];

  /** 校验主稿在该平台是否可发（缺字段/超长/违禁/类目未映射…）。
   *  右栏对照和发布执行共用同一套规则，保证"预览所见=发布所判"。 */
  validateDraft(input: {
    product: ProductRow;
    fields: DraftRow["fields"];
    shop: ShopRow;
  }): ChannelIssue[];

  /** mock 发布：校验后真正"写出去"的一步。
   *  返回外部商品 id/链接与落地状态（succeeded | review）。
   *  不得再抛校验错误——校验走 validateDraft；这里只模拟平台侧的
   *  审批结果（如 TikTok 常态审核中）。 */
  publish(deps: Deps, input: {
    product: ProductRow;
    fields: DraftRow["fields"];
    shop: ShopRow;
  }): Promise<{ status: "succeeded" | "review"; externalId: string; remoteUrl: string }>;
}
