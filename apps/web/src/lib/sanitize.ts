import DOMPurify from "dompurify";

/** AI 生成/采集 HTML 渲染前的净化：去 script/iframe/on* 属性/javascript: 链接。 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "button"],
    FORBID_ATTR: ["srcset"],
  });
}
