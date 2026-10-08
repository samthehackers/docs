import { NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { z, ZodTypeAny } from "zod";

export class HttpError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); }
}

export function handle<T extends unknown[]>(fn: (...a: T) => Promise<Response>) {
  return async (...a: T): Promise<Response> => {
    try {
      return await fn(...a);
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status });
      if (e instanceof z.ZodError) return NextResponse.json({ error: "Invalid input", issues: e.issues }, { status: 400 });
      console.error("[api]", e);
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
  };
}

/** Authenticated user id or 401. */
export async function requireUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId) throw new HttpError(401, "Unauthorized");
  return userId;
}

/** Admin check against Clerk publicMetadata (authoritative), enforced in every admin handler. */
export async function isAdmin(userId: string): Promise<boolean> {
  const c = await clerkClient();
  const u = await c.users.getUser(userId);
  return (u.publicMetadata as { role?: string })?.role === "admin";
}

export async function requireAdminId(): Promise<string> {
  const userId = await requireUserId();
  if (!(await isAdmin(userId))) throw new HttpError(403, "Forbidden");
  return userId;
}

export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try { raw = await req.json(); } catch { throw new HttpError(400, "Body must be JSON"); }
  return schema.parse(raw);
}

export function parseQuery<S extends ZodTypeAny>(url: string, schema: S): z.infer<S> {
  return schema.parse(Object.fromEntries(new URL(url).searchParams));
}

export function requireCron(req: Request) {
  const h = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || h !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, "Unauthorized");
}
