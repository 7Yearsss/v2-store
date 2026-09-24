import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CollectedOffer, Product } from "@caiji/shared";

const DATA_FILE = resolve(process.cwd(), "data", "products.jsonl");

/** JSONL-backed product store; swap for Postgres when persistence matters. */
export class ProductStore {
  private byId = new Map<string, Product>();
  private bySourceUrl = new Map<string, string>();

  constructor() {
    if (!existsSync(DATA_FILE)) return;
    for (const line of readFileSync(DATA_FILE, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line) as Product;
        this.byId.set(p.id, p);
        this.bySourceUrl.set(p.sourceUrl, p.id);
      } catch {
        /* skip corrupt line */
      }
    }
  }

  ingest(offer: CollectedOffer): { product: Product; duplicated: boolean } {
    const existingId = this.bySourceUrl.get(offer.sourceUrl);
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
