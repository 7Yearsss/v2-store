import type { DiscoverySignals } from "@caiji/shared";

/**
 * 从卡片纯文本提确定性信号：只写文本里明确出现的字段，提不到的留
 * undefined（诚实原则——拿不到不伪造）。1688 卡片文案经常变，这里宁缺毋滥。
 */
export function signalsFromText(text: string): DiscoverySignals {
  const t = text.replace(/\s+/g, " ");
  const s: DiscoverySignals = {};
  if (/一件代发|代发包邮|包邮代发/.test(t)) s.daiFa = true;
  if (/(?:24|48)\s*(?:小时|h)\s*发货/i.test(t) || /48h/i.test(t)) s.ship48h = true;
  const rr = t.match(/回头率\D{0,6}(\d+(?:\.\d+)?)\s*%/);
  if (rr) s.repurchaseRate = Math.min(1, Number(rr[1]) / 100);
  const years =
    t.match(/(\d{1,2})\s*年(?:老店|工厂|实力商家|商铺|店|诚信通)/) ??
    t.match(/(?:开店|经营|诚信通)\D{0,4}(\d{1,2})\s*年/);
  if (years) s.sellerYears = Number(years[1]);
  const same =
    t.match(/(\d{1,6})\s*件同款/) ?? t.match(/同款\s*(\d{1,6})/) ?? t.match(/(\d{1,6})\s*家同款/);
  if (same) s.sameStyleCount = Number(same[1]);
  return s;
}
