import { LoaderCircle, PackageSearch, TriangleAlert, X } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AttemptStatus, JobStatus, PlatformId } from "@studio/shared";
import "./studio.css";

/* ---------- 状态点 + 短文案 ---------- */
export function St({
  st,
  children,
}: {
  st: string | undefined;
  children?: ReactNode;
}) {
  return (
    <span className="st" data-tone={st}>
      <span className="st-dot" data-st={st} />
      {children}
    </span>
  );
}

export const JOB_TEXT: Record<JobStatus, string> = {
  queued: "排队中",
  running: "发布中",
  partial_success: "部分成功",
  succeeded: "成功",
  failed: "失败",
};

export const ATTEMPT_TEXT: Record<AttemptStatus, string> = {
  queued: "排队中",
  running: "发布中",
  review: "审核中",
  succeeded: "成功",
  failed: "失败",
};

export const PLATFORM_NAME: Record<PlatformId, string> = {
  shopee: "Shopee",
  tiktok: "TikTok",
};

export const SOURCE_NAME: Record<string, string> = {
  manual: "手工",
  import: "导入",
  link: "链接",
};

export function PlatformBadge({ id }: { id: PlatformId }) {
  return (
    <span className="pf" title={PLATFORM_NAME[id]}>
      {id === "shopee" ? "S" : "T"}
    </span>
  );
}

/* ---------- 缩略图（加载失败落灰块） ---------- */
export function Thumb({ src, lg }: { src: string | undefined; lg?: boolean }) {
  const [bad, setBad] = useState(false);
  if (!src || bad) {
    return (
      <span className={`thumb ph${lg ? " lg" : ""}`}>
        <PackageSearch size={lg ? 18 : 14} />
      </span>
    );
  }
  return (
    <img
      className={`thumb${lg ? " lg" : ""}`}
      src={src}
      alt=""
      loading="lazy"
      onError={() => setBad(true)}
    />
  );
}

/* ---------- 四态 ---------- */
export function Loading({ text = "加载中…" }: { text?: string }) {
  return (
    <div className="state">
      <LoaderCircle size={18} className="state-ico" style={{ animation: "st-spin 1s linear infinite" }} />
      {text}
      <style>{`@keyframes st-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state">
      <span className="state-ico">{icon ?? <PackageSearch size={20} />}</span>
      {children}
    </div>
  );
}

export function Err({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="state err">
      <TriangleAlert size={18} className="state-ico" />
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
    <div
      className="mo-ov"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="mo" style={width ? { width } : undefined} role="dialog" aria-label={title}>
        <div className="mo-head">
          {title}
          <button type="button" className="mo-x" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="mo-body">{children}</div>
        {footer && <div className="mo-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- 点外关闭的下拉锚 ---------- */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/* ---------- 时间 ---------- */
export function fmtTime(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
