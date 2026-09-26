import {
  CloseOutlined,
  DownOutlined,
  InboxOutlined,
  LoadingOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { useEffect, useState, type ReactNode } from "react";

/* ---------- 状态点 + 短文案 ---------- */
export function St({ st, children }: { st: string | undefined; children?: ReactNode }) {
  return (
    <span className="st" data-tone={st}>
      <span className="st-dot" data-st={st} />
      {children}
    </span>
  );
}

/* ---------- 缩略图（加载失败落灰块） ---------- */
export function Thumb({ src, lg }: { src: string | undefined; lg?: boolean }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) {
    return (
      <span className={`thumb ph${lg ? " lg" : ""}`}>
        <InboxOutlined style={{ fontSize: lg ? 18 : 14 }} />
      </span>
    );
  }
  return <img className={`thumb${lg ? " lg" : ""}`} src={src} alt="" loading="lazy" onError={() => setBad(true)} />;
}

/* ---------- 三态 ---------- */
export function Loading({ text = "加载中…" }: { text?: string }) {
  return (
    <div className="state">
      <LoadingOutlined className="state-ico" style={{ fontSize: 18 }} spin />
      {text}
    </div>
  );
}

export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state">
      <span className="state-ico">{icon ?? <InboxOutlined style={{ fontSize: 20 }} />}</span>
      {children}
    </div>
  );
}

export function Err({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state err">
      <WarningOutlined className="state-ico" style={{ fontSize: 18 }} />
      <span>{error instanceof Error ? error.message : "加载失败"}</span>
      {onRetry && (
        <button type="button" className="btn sm state-act" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

/* ---------- 弹层 ---------- */
export function Modal({
  title,
  onClose,
  children,
  footer,
  width,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="mo-ov" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="mo" style={width ? { width } : undefined} role="dialog" aria-label={title}>
        <div className="mo-head">
          {title}
          <button type="button" className="mo-x" onClick={onClose} aria-label="关闭">
            <CloseOutlined />
          </button>
        </div>
        <div className="mo-body">{children}</div>
        {footer && <div className="mo-foot">{footer}</div>}
      </div>
    </div>
  );
}

export { DownOutlined };
