const API_BASE = "http://localhost:3000";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "COLLECT") return;
  fetch(`${API_BASE}/api/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg.payload),
  })
    .then(async (r) => sendResponse({ ok: r.ok, data: await r.json() }))
    .catch((e) => sendResponse({ ok: false, error: String(e) }));
  return true; // async sendResponse
});
