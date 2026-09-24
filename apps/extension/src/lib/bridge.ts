/** Isolated-side bridge to the MAIN-world collector via CustomEvents. */

export function collectorRequest<T = any>(
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 30000,
): Promise<T> {
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      document.removeEventListener("v2:1688:res", onRes);
      reject(new Error("采集器无响应（页面可能还没加载完，稍后重试）"));
    }, timeoutMs);
    function onRes(ev: Event) {
      const d = (ev as CustomEvent).detail;
      if (!d || d.requestId !== requestId) return;
      document.removeEventListener("v2:1688:res", onRes);
      clearTimeout(timer);
      if (d.ok) resolve(d.result as T);
      else reject(new Error(d.error ?? "采集失败"));
    }
    document.addEventListener("v2:1688:res", onRes);
    document.dispatchEvent(
      new CustomEvent("v2:1688:req", {
        detail: { requestId, action, ...payload },
      }),
    );
  });
}
