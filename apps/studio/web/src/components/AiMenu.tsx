import { ChevronDown, Sparkles } from "lucide-react";
import type { AiField, AiMode, PlatformId } from "@studio/shared";
import { usePopover } from "./ui.js";

export interface AiAction {
  label: string;
  mode: AiMode;
  channel?: PlatformId;
}

/** 字段级 AI 动作菜单（与冻结 API 的 field/mode/channel 对应）。 */
export const AI_ACTIONS: Record<AiField, AiAction[]> = {
  title: [
    { label: "生成", mode: "generate" },
    { label: "更短", mode: "shorter" },
    { label: "更转化", mode: "more_converting" },
  ],
  description: [
    { label: "生成", mode: "generate" },
    { label: "按 Shopee 改写", mode: "channel_rewrite", channel: "shopee" },
    { label: "按 TikTok 改写", mode: "channel_rewrite", channel: "tiktok" },
  ],
  bullets: [{ label: "生成", mode: "generate" }],
  attributes: [{ label: "按类目补齐", mode: "category_fill" }],
  pricing: [{ label: "按费率倒推", mode: "margin_suggest" }],
};

export function AiMenu({
  field,
  busy,
  onRun,
}: {
  field: AiField;
  busy: boolean;
  onRun: (action: AiAction) => void;
}) {
  const { open, setOpen, ref } = usePopover();
  const actions = AI_ACTIONS[field];
  return (
    <div className="menu-anchor fld-ai" ref={ref}>
      <button
        type="button"
        className="fld-ai-btn"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="AI 生成此字段"
      >
        <Sparkles size={12} />
        AI
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="menu" role="menu">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onRun(a);
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
