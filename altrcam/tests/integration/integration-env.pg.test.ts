/**
 * Production's database configuration, on a REAL PostgreSQL through the production driver: no DATABASE_URL, only the
 * Vercel Supabase integration's POSTGRES_URL with its extra query parameters. Before the fix every signed-in page threw
 * "DATABASE_URL is not set" and the first signed-in visit never created the user's row; with the raw URL postgres.js
 * also sent `supa` to the server and the connection was refused ("unrecognized configuration parameter").
 *
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/an_empty_database npm run test:integration
 *
 * Skipped when TEST_DATABASE_URL is unset. It TRUNCATES the app's tables, so use a scratch database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ me: null as string | null, unconfirmed: new Set<string>() }));
vi.mock("@/lib/supabase/server", async () => (await import("../unit/supabase-auth-mock")).fakeServerModule(h));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;
const withParams = (u: string, extra: string) => `${u}${u.includes("?") ? "&" : "?"}${extra}`;
if (URL_) {
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_PRISMA_URL;
  process.env.POSTGRES_URL = withParams(URL_, "supa=base-pooler.x&pgbouncer=true");
}

import { db } from "@/lib/db";
import { creditLedger, users } from "@/db/schema";
import { requireAppUser } from "@/lib/session-user";

suite("the app on the Supabase integration's POSTGRES_URL (real PostgreSQL)", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => {
    admin = postgres(URL_!, { max: 1, prepare: false });
    await migrate(drizzle(admin), { migrationsFolder: "db/migrations" });
    await db().execute(sql`truncate users, credit_ledger, audit_log, notifications restart identity cascade`);
  });
  afterAll(async () => { await admin?.end(); });

  it("the raw integration URL is refused by the server, which is why it is cleaned", async () => {
    const raw = postgres(process.env.POSTGRES_URL!, { max: 1, prepare: false });
    await expect(raw`select 1`).rejects.toThrow(/unrecognized configuration parameter/);
    await raw.end();
  });

  it("db() connects through POSTGRES_URL with no DATABASE_URL", async () => {
    expect(process.env.DATABASE_URL).toBeUndefined();
    const r = await db().execute(sql`select 1 as ok`);
    expect([...r][0]).toMatchObject({ ok: 1 });
  });

  it("the first signed-in visit creates the user row and grants the signup credits, once", async () => {
    h.me = "supabase-user-1";
    const u = await requireAppUser();
    expect(u.id).toBe("supabase-user-1");
    expect(u.email).toBe("supabase-user-1@example.com");
    await requireAppUser(); // a second visit does not grant again
    const rows = await db().select().from(users).where(eq(users.id, "supabase-user-1"));
    expect(rows).toHaveLength(1);
    const ledger = await db().select().from(creditLedger).where(eq(creditLedger.userId, "supabase-user-1"));
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("signup_grant");
    expect(ledger[0].delta).toBeGreaterThan(0);
  });

  it("an unconfirmed email is sent to /verify-email and gets no row", async () => {
    h.me = "unconfirmed-user";
    h.unconfirmed = new Set(["unconfirmed-user"]);
    await expect(requireAppUser()).rejects.toThrow("REDIRECT /verify-email");
    expect(await db().select().from(users).where(eq(users.id, "unconfirmed-user"))).toHaveLength(0);
  });
});
