import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { FreightForwarder, ShippingAddress } from "@caiji/shared";
import type { AppEnv, Deps } from "../context.js";
import { freightForwarders } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

type Row = typeof freightForwarders.$inferSelect;

const addressSchema = z.object({
  recipient: z.string().trim().max(64).optional(),
  phone: z.string().trim().max(32).optional(),
  country: z.string().trim().max(64).optional(),
  province: z.string().trim().max(64).optional(),
  city: z.string().trim().max(64).optional(),
  address1: z.string().trim().min(1).max(255),
  address2: z.string().trim().max(255).optional(),
  postcode: z.string().trim().max(16).optional(),
});

/** 启动时跑一次：把迁移前 plaintext JSON 残留的 address_enc 转成密文。 */
export async function sweepLegacyFwAddresses(deps: Pick<Deps, "db" | "secrets">) {
  const rows = await deps.db
    .select({ id: freightForwarders.id, addressEnc: freightForwarders.addressEnc })
    .from(freightForwarders);
  for (const r of rows) {
    if (r.addressEnc && !r.addressEnc.startsWith("v1.")) {
      try {
        await deps.db
          .update(freightForwarders)
          .set({ addressEnc: deps.secrets.seal(JSON.parse(r.addressEnc)) })
          .where(eq(freightForwarders.id, r.id));
      } catch {
        // 非 JSON 残留跳过（本来就不可读）
      }
    }
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  address: addressSchema,
  /** 货代系统类型：huoxiaoyi（可直连）|manual 等。 */
  systemType: z.string().trim().max(50).optional(),
  note: z.string().trim().max(500).optional(),
});
const patchSchema = createSchema.partial();

/** 地址存 SecretBox 密文；旧行（若从早期 jsonb 迁移来）按 JSON 兜底读。 */
export function openFwAddress(deps: Pick<Deps, "secrets">, raw: string | null): ShippingAddress {
  if (!raw) return {};
  try {
    return deps.secrets.open<ShippingAddress>(raw);
  } catch {
    try {
      return JSON.parse(raw) as ShippingAddress;
    } catch {
      return {};
    }
  }
}

const toDto = (deps: Deps, r: Row): FreightForwarder => ({
  id: r.id,
  name: r.name,
  address: openFwAddress(deps, r.addressEnc),
  systemType: r.systemType,
  note: r.note,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** 货代地址簿：采购单收货地址的切换来源。 */
export function freightForwarderRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const rows = await c.var.deps.db
      .select()
      .from(freightForwarders)
      .where(eq(freightForwarders.workspaceId, c.var.auth.workspaceId));
    return c.json({ items: rows.map((r2) => toDto(c.var.deps, r2)), total: rows.length });
  });

  r.post("/", zValidator("json", createSchema), async (c) => {
    const body = c.req.valid("json");
    const [row] = await c.var.deps.db
      .insert(freightForwarders)
      .values({
        workspaceId: c.var.auth.workspaceId,
        name: body.name,
        addressEnc: c.var.deps.secrets.seal(body.address),
        note: body.note ?? null,
      })
      .returning();
    return c.json(toDto(c.var.deps, row!), 201);
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const patch = c.req.valid("json");
    const [row] = await c.var.deps.db
      .update(freightForwarders)
      .set({
        name: patch.name,
        systemType: patch.systemType,
        note: patch.note,
        ...(patch.address
          ? { addressEnc: c.var.deps.secrets.seal(patch.address) }
          : {}),
      })
      .where(
        and(
          eq(freightForwarders.id, c.req.param("id")),
          eq(freightForwarders.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning();
    if (!row) throw notFound("货代");
    return c.json(toDto(c.var.deps, row));
  });

  r.delete("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .delete(freightForwarders)
      .where(
        and(
          eq(freightForwarders.id, c.req.param("id")),
          eq(freightForwarders.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .returning({ id: freightForwarders.id });
    if (!row) throw notFound("货代");
    return c.json({ ok: true });
  });

  return r;
}
