import { Sparkles } from "lucide-react";

const POOL = [
  { title: "复古工装夹克外套男", sub: "链接生成 · 已建草稿", st: "ready" },
  { title: "ins风陶瓷马克杯 350ml", sub: "CSV 导入", st: "draft" },
  { title: "户外防水登山鞋女款", sub: "手工创建", st: "draft" },
  { title: "法式碎花连衣裙夏", sub: "CSV 导入", st: "ready" },
  { title: "机械键盘青轴 87键", sub: "链接生成 · 待补字段", st: "draft" },
];

const CHECKS = [
  { name: "马来店", meta: "shopee · MY", st: "success", note: "校验通过，可发布" },
  { name: "新加坡店", meta: "shopee · SG", st: "partial_success", note: "缺字段：UPC" },
  { name: "美国店", meta: "tiktok · US", st: "failed", note: "授权过期，需重新授权" },
];

/** /__demo 演示页：假三栏内容，只为展示壳层与状态点。 */
export function DemoContent() {
  return (
    <div className="sh-demo">
      <section className="demo-col">
        <div className="demo-col-head">
          商品池<span className="demo-count">5</span>
        </div>
        <div className="demo-col-body">
          {POOL.map((p, i) => (
            <div key={p.title} className={`demo-row${i === 0 ? " sel" : ""}`}>
              <span className="demo-thumb" />
              <div style={{ minWidth: 0 }}>
                <div className="demo-row-title">{p.title}</div>
                <div className="demo-row-sub">{p.sub}</div>
              </div>
              <span className="st-dot" data-st={p.st} style={{ marginLeft: "auto" }} />
            </div>
          ))}
        </div>
      </section>

      <section className="demo-col">
        <div className="demo-col-head">
          主稿<span className="demo-count">复古工装夹克外套男</span>
        </div>
        <div className="demo-col-body">
          <div className="demo-field">
            <div className="demo-label">
              标题<Sparkles size={12} className="demo-ai" />
            </div>
            <div className="demo-input">Vintage Workwear Jacket 复古工装夹克</div>
          </div>
          <div className="demo-field">
            <div className="demo-label">
              卖点<Sparkles size={12} className="demo-ai" />
            </div>
            <div className="demo-input multi">· 重磅棉料，挺括耐穿 · 多口袋工装设计 · 男女同款宽松版型</div>
          </div>
          <div className="demo-field">
            <div className="demo-label">
              描述<Sparkles size={12} className="demo-ai" />
            </div>
            <div className="demo-input multi">源自 90 年代美式工装的廓形夹克，重磅斜纹棉水洗做旧，四袋立体裁剪，通勤与户外两穿。</div>
          </div>
          <div className="demo-field">
            <div className="demo-label">价格 / 库存</div>
            <div className="demo-input">RM 89.00 · 库存 240 · 6 个 SKU</div>
          </div>
          <div className="demo-field">
            <div className="demo-label">
              类目 / 属性<Sparkles size={12} className="demo-ai" />
            </div>
            <div className="demo-input">男装 / 外套 · 材质：棉 · 风格：工装</div>
          </div>
          <div className="demo-field">
            <div className="demo-label">变体（规格）</div>
            <div className="demo-input multi">颜色：卡其 / 军绿 / 黑 —— 尺码：S / M / L / XL</div>
          </div>
        </div>
      </section>

      <section className="demo-col">
        <div className="demo-col-head">
          店铺对照<span className="demo-count">3 店</span>
        </div>
        <div className="demo-col-body" style={{ flex: "none" }}>
          {CHECKS.map((c) => (
            <div key={c.name} className="demo-check">
              <div className="demo-check-head">
                <span className="st-dot" data-st={c.st} />
                <b>{c.name}</b>
                <span className="demo-check-meta">{c.meta}</span>
              </div>
              <div className="demo-issue">
                <span className="st-dot" data-st={c.st} />
                {c.note}
              </div>
            </div>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button type="button" className="demo-cta">
          铺到 2 家店
        </button>
      </section>
    </div>
  );
}
