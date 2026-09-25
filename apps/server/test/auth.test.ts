import { afterEach, describe, expect, it } from "vitest";
import { harvest, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("auth", () => {
  it("registers, reads me, rejects bad login and duplicate email", async () => {
    ctx = await setup();
    const token = await ctx.register("owner@test.dev");
    const me = await ctx.api("GET", "/api/auth/me", undefined, token);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe("owner@test.dev");
    expect(me.body.role).toBe("owner");

    const dup = await ctx.api("POST", "/api/auth/register", {
      email: "owner@test.dev",
      password: "password123",
      name: "x",
    });
    expect(dup.status).toBe(409);

    const bad = await ctx.api("POST", "/api/auth/login", {
      email: "owner@test.dev",
      password: "wrong-password",
    });
    expect(bad.status).toBe(401);

    const ok = await ctx.api("POST", "/api/auth/login", {
      email: "owner@test.dev",
      password: "password123",
    });
    expect(ok.status).toBe(200);
  });

  it("requires a session and invalidates it on logout", async () => {
    ctx = await setup();
    expect((await ctx.api("GET", "/api/source-items")).status).toBe(401);
    const token = await ctx.register();
    await ctx.api("POST", "/api/auth/logout", {}, token);
    expect((await ctx.api("GET", "/api/auth/me", undefined, token)).status).toBe(401);
  });

  it("issues extension tokens only from web sessions", async () => {
    ctx = await setup();
    const web = await ctx.register();
    const ext = await ctx.api("POST", "/api/auth/extension-token", {}, web);
    expect(ext.status).toBe(200);
    const again = await ctx.api("POST", "/api/auth/extension-token", {}, ext.body.token);
    expect(again.status).toBe(403);
    // the extension token is accepted for collection
    const res = await ctx.api("POST", "/api/collect", harvest("100"), ext.body.token);
    expect(res.status).toBe(201);
  });

  it("isolates workspaces", async () => {
    ctx = await setup();
    const a = await ctx.register("a@test.dev");
    const b = await ctx.register("b@test.dev");
    const created = await ctx.api("POST", "/api/collect", harvest("200"), a);
    const id = created.body.item.id;
    expect((await ctx.api("GET", `/api/source-items/${id}`, undefined, b)).status).toBe(404);
    const listB = await ctx.api("GET", "/api/source-items", undefined, b);
    expect(listB.body.total).toBe(0);
    // B collecting the same offer gets its own row
    const createdB = await ctx.api("POST", "/api/collect", harvest("200"), b);
    expect(createdB.status).toBe(201);
    expect(createdB.body.item.id).not.toBe(id);
  });
});
