import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { timingSafeEqual } from "node:crypto";
import { z, ZodTypeAny } from "zod";
export class HttpError extends Error { constructor(public status: number, message: string, public extra?: Record<string, unknown>) { super(message); } }
export function handle<T extends unknown[]>(fn: (...a: T) => Promise<Response>) { return async (...a: T): Promise<Response> => { try { return await fn(...a); } catch (e) { if (e instanceof HttpError) return NextResponse.json({ error: e.message, ...e.extra }, { status: e.status }); if (e instanceof z.ZodError) return NextResponse.json({ error: "Invalid input", issues: e.issues }, { status: 400 }); console.error("[api]", e); return NextResponse.json({ error: "Internal error" }, { status: 500 }); } }; }
/** Email/password accounts must confirm their address first; OAuth accounts (Google) arrive confirmed. */
export const emailConfirmed = (user: Pick<User, "email_confirmed_at">) => Boolean(user.email_confirmed_at);
/** The server-verified user id (Supabase `getUser()` checks the session with the Auth server; the cookie alone is never trusted). */
export async function requireUserId(): Promise<string> {
  const { data: { user } } = await (await createClient()).auth.getUser();
  if (!user) throw new HttpError(401, "Unauthorized");
  if (!emailConfirmed(user)) throw new HttpError(403, "Confirm your email address first", { code: "email_unconfirmed" });
  return user.id;
}
/** Admin = `app_metadata.role === "admin"`. app_metadata can only be written with the secret key, never by the user. */
export async function isAdmin(userId: string): Promise<boolean> { const { data: { user } } = await (await createClient()).auth.getUser(); return user?.id === userId && user.app_metadata?.role === "admin"; }
export async function requireAdminId(): Promise<string> { const userId = await requireUserId(); if (!(await isAdmin(userId))) throw new HttpError(403, "Forbidden"); return userId; }
export async function parseBody<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> { let raw: unknown; try { raw = await req.json(); } catch { throw new HttpError(400, "Body must be JSON"); } return schema.parse(raw); }
export function parseQuery<S extends ZodTypeAny>(url: string, schema: S): z.infer<S> { return schema.parse(Object.fromEntries(new URL(url).searchParams)); }
export function requireCron(req: Request) { const secret = process.env.CRON_SECRET; if (!secret) throw new HttpError(401, "Unauthorized"); const got = Buffer.from(req.headers.get("authorization") ?? ""); const want = Buffer.from(`Bearer ${secret}`); if (got.length !== want.length || !timingSafeEqual(got, want)) throw new HttpError(401, "Unauthorized"); }
