import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CollectedOffer, Product } from "@caiji/shared";

const DATA_FILE = resolve(process.cwd(), "data", "products.jsonl");

/** JSONL-backed product store; swap for Postgres when persistence matters. */
export class ProductStore {
  private byId = new Map<string, Product>();
  private bySourceUrl = new Map<string, string>();
  private byOfferId = new Map<string, string>();

  constructor() {
    if (!existsSync(DATA_FILE)) return;
    for (const line of readFileSync(DATA_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Product;
        this.byId.set(p.id, p);
        this.bySourceUrl.set(p.sourceUrl, p.id);
        if (p.offerId) this.byOfferId.set(p.offerId, p.id);
      } catch {
        /* skip corrupt line */
      }
    }
  }

  ingest(offer: CollectedOffer): { product: Product; duplicated: boolean } {
    const existingId =
      this.bySourceUrl.get(offer.sourceUrl) ??
      (offer.offerId ? this.byOfferId.get(offer.offerId) : undefined);
    if (existingId) {
      const existing = this.byId.get(existingId)!;
      const merged: Product = { ...existing, ...offer, id: existing.id };
      this.byId.set(existing.id, merged);
      this.persist(merged);
      return { product: merged, duplicated: true };
    }
    const product: Product = { ...offer, id: randomUUID(), status: "draft" };
    this.byId.set(product.id, product);
    this.bySourceUrl.set(product.sourceUrl, product.id);
    if (product.offerId) this.byOfferId.set(product.offerId, product.id);
    this.persist(product);
    return { product, duplicated: false };
  }

  list(): Product[] {
    return [...this.byId.values()].sort((a, b) =>
      b.collectedAt.localeCompare(a.collectedAt),
    );
  }

  get(id: string): Product | undefined {
    return this.byId.get(id);
  }

  /** Dedup lookup by itemUrl and/or offerId — the batch_check_item_has_fetch
   *  equivalent. */
  hasCollected(itemUrl?: string, itemId?: string): boolean {
    if (itemUrl && this.bySourceUrl.has(itemUrl)) return true;
    if (itemId && this.byOfferId.has(itemId)) return true;
    if (
      itemId &&
      this.bySourceUrl.has(`https://detail.1688.com/offer/${itemId}.html`)
    ) {
      return true;
    }
    return false;
  }

  update(id: string, patch: Partial<Product>): Product | undefined {
    const cur = this.byId.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    this.byId.set(id, next);
    this.persist(next);
    return next;
  }

  private persist(p: Product) {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    appendFileSync(DATA_FILE, JSON.stringify(p) + "\n");
  }
}
