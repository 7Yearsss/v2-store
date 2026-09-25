import { Link2, Sparkles, Upload } from "lucide-react";

/** /__demo 的三栏假内容：左商品池 / 中主稿字段 / 右店铺对照，只为展示壳密度。 */

const DEMO_PRODUCTS = [
  { id: "p1", title: "复古灯芯绒棒球帽 男女同款", sub: "2 个 SKU · 1688", st: "ready" },
  { id: "p2", title: "ins风磨砂陶瓷马克杯 350ml", sub: "1 个 SKU · 手动", st: "ready" },
  { id: "p3", title: "日系叠戴钛钢项链套装", sub: "4 个 SKU · 链接", st: "draft" },
  { id: "p4", title: "可折叠硅胶收纳篮 三件套", sub: "3 个 SKU · 导入", st: "draft" },
  { id: "p5", title: "法式亚麻宽松衬衫", sub: "6 个 SKU · 1688", st: "ready" },
  { id: "p6", title: "便携迷你挂脖风扇", sub: "2 个 SKU · 导入", st: "draft" },
];

const DEMO_BULLETS = [
  "灯芯绒面料，软顶弯檐，秋冬百搭",
  "可调节按扣，56–60cm 头围",
  "男女同款，四色可选",
];

const DEMO_SHOPS = [
  {
    name: "Reizo 马来站",
    meta: "shopee · MY",
    st: "ready",
    stText: "可发布",
    issue: null as string | null,
    foot: "预估售价 RM 39.90",
  },
  {
    name: "Reizo 新加坡站",
    meta: "shopee · SG",
    st: "review",
    stText: "需人工确认",
    issue: "类目映射待确认：服饰/帽子",
    foot: "预估售价 S$ 14.90",
  },
  {
    name: "Reizo 美区",
    meta: "tiktok · US",
    st: "failed",
    stText: "缺字段",
    issue: "missing_field: brand / UPC",
    foot: "授权即将过期 · 建议 reauth",
  },
];

export function DemoContent() {
  return (
    <div className="demo-grid">
      <div className="demo-col">
        <div className="demo-head">
          <span>商品池 · 24</span>
          <span className="demo-head-actions">
            <button type="button" className="demo-ghost-btn">
              <Upload size={12} /> 导入
            </button>
            <button type="button" className="demo-ghost-btn">
              <Link2 size={12} /> 链接
            </button>
          </span>
        </div>
        {DEMO_PRODUCTS.map((p, i) => (
          <div key={p.id} className={i === 0 ? "demo-row sel" : "demo-row"}>
            <span className="st-dot" data-st={p.st} aria-hidden />
            <div className="demo-row-text">
              <div className="demo-row-title">{p.title}</div>
              <div className="demo-row-sub">{p.sub}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="demo-col">
        <div className="demo-head">
          <span>主稿 · 复古灯芯绒棒球帽</span>
          <span className="demo-head-actions">
            <span className="demo-row-sub">草稿 · 已自动保存</span>
          </span>
        </div>
        <div className="demo-field">
          <div className="demo-field-label">
            <span>标题</span>
            <button type="button" className="demo-ghost-btn">
              <Sparkles size={12} /> AI 重写
            </button>
          </div>
          <div className="demo-input">复古灯芯绒棒球帽 男女同款 秋冬百搭弯檐帽</div>
        </div>
        <div className="demo-field">
          <div className="demo-field-label">
            <span>卖点</span>
            <button type="button" className="demo-ghost-btn">
              <Sparkles size={12} /> AI 生成
            </button>
          </div>
          {DEMO_BULLETS.map((b) => (
            <div key={b} className="demo-bullet">
              {b}
            </div>
          ))}
        </div>
        <div className="demo-field">
          <div className="demo-field-label">
            <span>价格 / 库存</span>
          </div>
          <div className="demo-two">
            <div className="demo-input">¥ 39.00</div>
            <div className="demo-input">库存 1,240</div>
          </div>
        </div>
        <div className="demo-field">
          <div className="demo-field-label">
            <span>类目</span>
            <button type="button" className="demo-ghost-btn">
              <Sparkles size={12} /> AI 补齐
            </button>
          </div>
          <div className="demo-input">服饰配件 / 帽子 / 棒球帽</div>
        </div>
        <div className="demo-field">
          <div className="demo-field-label">
            <span>描述</span>
            <button type="button" className="demo-ghost-btn">
              <Sparkles size={12} /> AI 改写
            </button>
          </div>
          <div className="demo-input" style={{ minHeight: 64 }}>
            经典灯芯绒材质，软顶设计贴合头型；弯檐遮阳，日常通勤与出游皆宜……
          </div>
        </div>
      </div>

      <div className="demo-col">
        <div className="demo-head">
          <span>店铺对照 · 3</span>
        </div>
        {DEMO_SHOPS.map((s) => (
          <div key={s.name} className="demo-card">
            <div className="demo-card-title">{s.name}</div>
            <div className="demo-card-meta">{s.meta}</div>
            <div className="demo-card-issue">
              <span className="st-dot" data-st={s.st} aria-hidden />
              {s.stText}
              {s.issue ? ` · ${s.issue}` : ""}
            </div>
            <div className="demo-card-foot">{s.foot}</div>
          </div>
        ))}
        <div style={{ margin: "0 12px" }}>
          <button type="button" className="demo-btn-primary">
            铺到 3 家店
          </button>
        </div>
      </div>
    </div>
  );
}
