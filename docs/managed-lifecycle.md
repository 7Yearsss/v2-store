# 统一采集、刊登与托管架构

> 2026-09-26。基于现有真实链路、`apps/studio` 体验切片，以及妙手、店小秘、Sellbrite、Listing Mirror、Linnworks、AutoDS 的官方资料完成内部评审。

## 裁决

生产链路只有一套：

```text
1688 插件
  → source_items 采集池
  → listings 店铺草稿
  → listing_suggestions 字段级 AI 建议
  → jobs 异步发布
  → listings 远端商品托管状态
```

- `apps/server` 是唯一后端，继续负责 workspace、认证、加密凭据、媒体、任务队列和真实 Shopify adapter。
- `apps/web` 是唯一工作台，吸收 `apps/studio/web` 的五导航、深色壳、三栏铺货和逐店任务体验。
- `apps/studio` 保留为 Phase 0 设计与故障演示参考，不作为生产数据源，不继续接真实采集或店铺。
- 不新增 `listing_drafts`。现有 `listings` 已同时承担“认领后的店铺草稿”和“发布后的在线商品投影”；再增加活跃主稿会形成 `主稿 → 店稿 → 远端` 三层双写。
- `source_items` 是供应商原料，不是可直接发布的商品主稿。跨店复用通过认领规则、AI 建议和批量应用完成，不增加第二份商品实体。
- 发布历史和当前商品状态分离：`publish_runs` / `publish_attempts` 记录一次执行，`listings` 保存当前远端状态、同步策略和冲突。

## 为什么不把真实链路迁进 studio

studio server 没有 workspace 隔离、生产认证、凭据加密、真实媒体管线和 Shopify API，平台发布也是确定性 mock。把真实链路反向迁入会重写已有能力并产生第二套数据所有权。

studio 值得保留的是产品设计：

1. 铺货页三栏：采集池、当前店稿、渠道状态。
2. 一次多店发布按 run 聚合、按 attempt 展示。
3. 预览和真正发布共用结构化渠道校验。
4. 发布后不跳页，逐店状态原地更新。
5. 自动动作和人工动作都能追溯。

## 字段所有权

| 字段组 | 默认真相 | 冲突处理 |
|---|---|---|
| 来源价格、来源库存、货源存活 | `source_items` 最近一次采集 | 先生成变化记录；库存仅在启用跟踪时自动推送，其他变化默认提示 |
| 标题、描述、图片、类目、属性 | `listings` 店稿 | 拉取远端快照并标记 drift，不静默回写任一侧 |
| 售价 | `listings` 店稿 | 平台侧变化标记 drift；用户明确同步时才覆盖 |
| 远端状态、外部 ID、链接 | 渠道 | 定时或手动回拉；远端删除只标记，不删除本地记录 |
| AI 内容 | `listing_suggestions` | 接受前不覆盖 `listings` |

## 托管状态

每条 `listing` 需要同时表达三个轴，避免把所有问题压成一个“失败”：

1. 本地执行：草稿、发布中、已发布、失败。
2. 远端状态：在售、草稿、归档、审核中、下架、远端删除。
3. 关联和健康：已关联、未关联、存在字段漂移、来源变化、授权异常。

`publish_attempt` 是历史事件，不替代 `listing` 当前状态。重试会创建新 attempt，并通过 `retryOf` 指向原失败记录。

## 同步规则

- 写远端前先拉远端快照，避免用陈旧副本无提示覆盖平台后台修改。
- 远端内容漂移先展示字段差异，不自动选择本地或远端。
- 来源回扫继续使用插件的 4 小时 alarm。自动动作必须记录 actor、规则、前后值和结果。
- 库存自动同步只在店稿启用库存跟踪时执行，并优先使用库存专用 adapter 动作，避免为库存变化全量重发商品内容。
- 授权过期暂停该店外部任务，保留全部来源、店稿、远端 ID 和历史。
- 远端删除标记为可修复状态，可重新发布或重新关联，不本地硬删。

## 产品信息架构

一级导航固定为：

1. 铺货
2. 商品
3. 店铺
4. 任务
5. 设置

采集池是铺货页左栏的第一阶段，可进入全宽模式，但不占一级导航。AI 只出现在字段动作和待审核建议区，不提供独立聊天首页。

铺货页：

- 左栏：真实采集池、插件采集、待认领和已认领。
- 中栏：同一货源的店稿切换、字段编辑、AI 建议审核。
- 右栏：逐店校验、授权、发布和远端状态；全页只有一个发布主按钮。

商品页负责发布后的日常托管，任务页负责跨商品的失败和异步执行历史。两者不互相代替。

## 本期边界

本期必须闭环：

- 真实 1688 采集、采集池和多店认领。
- 字段级 AI 建议与人工接受。
- Shopify 真实预览、异步发布、外部 ID 和链接回写。
- 发布 run / attempt、部分成功、单店重试。
- 远端状态和内容快照回拉、漂移提示、远端删除提示。
- 来源回扫、自动动作可见、同步策略和审计。
- 五导航深色统一工作台。

架构预留但本期不扩 UI：

- 第二个真实渠道 adapter。
- 渠道 webhook 替代轮询。
- 远端内容拉回成为本地主稿。
- 自动改价、最大损失护栏和来源替换。

明确不做：

- 订单、仓库、采购、物流、广告和客服。
- 自动换供应商。
- 平台后台直建商品的自动接管。
- 按平台复制一套平行后台。

## 竞品证据

- 妙手来源同步支持人工审核或自动更新、差异勾选和定价公式：https://erp.91miaoshou.com/help_center/article_2971.html
- 妙手批量修改提供预览、执行历史和还原：https://erp.91miaoshou.com/help_center/article_2963.html
- 店小秘要求编辑前先同步，说明陈旧副本会覆盖平台修改：https://help.dianxiaomi.com/faq/productFAQ/1883
- Sellbrite 把渠道 listing 与 catalog product 的关联作为独立步骤：https://support.sellbrite.com/en/articles/3367178-step-4-linking-listings-to-products
- Listing Mirror 按渠道配置价格方向：https://success.listingmirror.com/article/143-manage-price-settings-for-each-marketplace
- Listing Mirror 展示外部 ID、渠道链接和强制更新动作：https://success.listingmirror.com/article/18-view-and-edit-marketplace-listings
- Linnworks 明确库存由本地系统单向推送到渠道：https://apidocs.linnworks.net/docs/endpoint-inventory-faq
- AutoDS 区分 tracked / untracked 商品，并允许重新关联来源：https://help.autods.com/en/articles/13688541-untracked-products-connect-them-to-autods-automation
