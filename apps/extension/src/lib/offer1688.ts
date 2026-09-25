// Parsing lives in @caiji/shared so the server can re-parse harvested HTML
// with the same code path (site adaptors hot-update server-side).
export {
  deepFind,
  descImagesFromHtml,
  descUrlFromData,
  findInitData,
  findOfferList,
  normalizeOffer,
  normalizeUrl,
  productOnlyData,
  tryParseJson,
} from "@caiji/shared";
