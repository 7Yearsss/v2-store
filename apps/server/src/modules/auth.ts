import { zValidator } from "@hono/zod-validator";
import { and, eq, gt } from "drizzle-orm";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { Me } from "@caiji/shared";
import type { AppEnv, Deps } from "../context.js";
import { memberships, sessions, users, workspaces } from "../db/schema.js";
import { hashPassword, newToken, sha256, verifyPassword } from "../lib/crypto.js";
import { HttpError } from "../lib/errors.js";

export const SESSION_COOKIE = "sid";
const EXTENSION_TTL_DAYS = 90;

async function createSession(
  deps: Deps,
  userId: string,
  workspaceId: string,
  kind: "web" | "extension",
) {
  const token = newToken();
  const days = kind === "extension" ? EXTENSION_TTL_DAYS : deps.config.sessionTtlDays;
  const expiresAt = new Date(Date.now() + days * 86400_000);
  await deps.db.insert(sessions).values({
    tokenHash: sha256(token),
    userId,
    workspaceId,
    kind,
    expiresAt,
  });
  return { token, expiresAt };
}

function readToken(c: Parameters<Parameters<typeof createMiddleware<AppEnv>>[0]>[0]) {
  const header = c.req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  return getCookie(c, SESSION_COOKIE);
}

/** Resolves the session (cookie for web, Bearer for extension) into c.var.auth. */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const token = readToken(c);
  if (!token) throw new HttpError(401, "未登录", "unauthenticated");
  const { db } = c.var.deps;
  const [row] = await db
    .select({
      userId: sessions.userId,
      workspaceId: sessions.workspaceId,
      kind: sessions.kind,
      role: memberships.role,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .innerJoin(
      memberships,
      and(
        eq(memberships.userId, sessions.userId),
        eq(memberships.workspaceId, sessions.workspaceId),
      ),
    )
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);
  if (!row) throw new HttpError(401, "登录已过期", "unauthenticated");
  // Touch at most once a minute to keep writes off the hot path.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db
      .update(sessions)
      .set({ lastUsedAt: new Date() })
      .where(eq(sessions.tokenHash, sha256(token)));
  }
  c.set("auth", {
    userId: row.userId,
    workspaceId: row.workspaceId,
    role: row.role,
    sessionKind: row.kind,
  });
  await next();
});

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, "密码至少 8 位").max(200),
  name: z.string().trim().min(1).max(60),
  workspaceName: z.string().trim().min(1).max(60).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export function authRoutes() {
  const r = new Hono<AppEnv>();

  const setSessionCookie = (
    c: Parameters<typeof setCookie>[0],
    deps: Deps,
    token: string,
    expiresAt: Date,
  ) =>
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: deps.config.secureCookies,
      path: "/",
      expires: expiresAt,
    });

  r.post("/register", zValidator("json", registerSchema), async (c) => {
    const deps = c.var.deps;
    const body = c.req.valid("json");
    const passwordHash = await hashPassword(body.password);
    const result = await deps.db.transaction(async (tx) => {
      const [exists] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, body.email));
      if (exists) throw new HttpError(409, "该邮箱已注册", "email_taken");
      const [user] = await tx
        .insert(users)
        .values({ email: body.email, name: body.name, passwordHash })
        .returning();
      const [ws] = await tx
        .insert(workspaces)
        .values({ name: body.workspaceName ?? `${body.name} 的团队` })
        .returning();
      await tx
        .insert(memberships)
        .values({ userId: user!.id, workspaceId: ws!.id, role: "owner" });
      return { user: user!, ws: ws! };
    });
    const { token, expiresAt } = await createSession(
      deps,
      result.user.id,
      result.ws.id,
      "web",
    );
    setSessionCookie(c, deps, token, expiresAt);
    return c.json({ ok: true }, 201);
  });

  r.post("/login", zValidator("json", loginSchema), async (c) => {
    const deps = c.var.deps;
    const { email, password } = c.req.valid("json");
    const [user] = await deps.db.select().from(users).where(eq(users.email, email));
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      throw new HttpError(401, "邮箱或密码错误", "bad_credentials");
    }
    const [m] = await deps.db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, user.id))
      .orderBy(memberships.createdAt)
      .limit(1);
    if (!m) throw new HttpError(403, "账号未加入任何团队");
    const { token, expiresAt } = await createSession(deps, user.id, m.workspaceId, "web");
    setSessionCookie(c, deps, token, expiresAt);
    return c.json({ ok: true });
  });

  r.post("/logout", async (c) => {
    const token = readToken(c);
    if (token) {
      await c.var.deps.db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
    }
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  r.get("/me", requireAuth, async (c) => {
    const { db } = c.var.deps;
    const auth = c.var.auth;
    const [row] = await db
      .select({ user: users, workspace: workspaces })
      .from(users)
      .innerJoin(workspaces, eq(workspaces.id, auth.workspaceId))
      .where(eq(users.id, auth.userId));
    if (!row) throw new HttpError(401, "账号不存在");
    const me: Me = {
      user: { id: row.user.id, email: row.user.email, name: row.user.name },
      workspace: {
        id: row.workspace.id,
        name: row.workspace.name,
        plan: row.workspace.plan,
      },
      role: auth.role,
    };
    return c.json(me);
  });

  /** Mint a long-lived bearer for the browser extension (handed over via site-bridge). */
  r.post("/extension-token", requireAuth, async (c) => {
    const auth = c.var.auth;
    if (auth.sessionKind !== "web") {
      throw new HttpError(403, "只能从网页端签发插件令牌");
    }
    const { token, expiresAt } = await createSession(
      c.var.deps,
      auth.userId,
      auth.workspaceId,
      "extension",
    );
    return c.json({ token, expiresAt: expiresAt.toISOString() });
  });

  return r;
}
