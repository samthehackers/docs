/**
 * The signed Paystack webhook path end to end, replacing the browser flow test that needed the old auth provider:
 * a user at zero credits is refused by the Studio start gate; a charge.success with a bad signature is refused (401) and
 * grants nothing; the same event with a good signature grants the top-up once; a replay does not grant again; and the
 * credits then let the Studio start a session. Real route handlers on an in-memory Postgres; only Paystack's server-to-server
 * verify call (fetch) and the Supabase getUser seam are faked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown, me: null as string | null }));
vi.mock("@/lib/supabase/server", async () => (await import("./supabase-auth-mock")).fakeServerModule(h));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { payments, studioSessions, users } from "@/db/schema";
import { ledgerBalance } from "@/lib/credits";
import * as webhook from "@/app/api/webhooks/paystack/route";
import * as startRoute from "@/app/api/studio/session/start/route";

const SECRET = "sk_test_flow_secret";
const REF = "alt_flowtest0001";
const sign = (body: string) => createHmac("sha512", SECRET).update(body).digest("hex");

let d: DB;
const realFetch = globalThis.fetch;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);
beforeEach(async () => {
  Object.assign(process.env, { PAYSTACK_SECRET_KEY: SECRET, FAL_KEY: "test-key", PRICE_CURRENCY: "NGN", PRICE_TOPUP_1K: "300000" });
  await d.execute(sql`truncate users, payments, webhook_events, credit_ledger, studio_sessions, audit_log, notifications restart identity cascade`);
  await d.insert(users).values({ id: "u1", email: "u1@example.com", name: "U1" }); // no signup grant: zero credits
  await d.insert(payments).values({ userId: "u1", provider: "paystack", reference: REF, kind: "topup", product: "TOPUP_1K", amountMinor: 300000, currency: "NGN", status: "pending" });
  // Paystack's GET /transaction/verify/:ref, as the app calls it after every webhook.
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(String(input)).toContain(`/transaction/verify/${REF}`);
    return Response.json({ status: true, data: { reference: REF, status: "success", amount: 300000, currency: "NGN", metadata: { userId: "u1", product: "TOPUP_1K" }, customer: { email: "u1@example.com" } } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

const body = JSON.stringify({ event: "charge.success", data: { reference: REF, id: 1 } });
const post = (sig: string) => webhook.POST(new Request("http://x/api/webhooks/paystack", { method: "POST", body, headers: { "x-paystack-signature": sig, "content-type": "application/json" } }));
const startSession = () => { h.me = "u1"; return startRoute.POST(new Request("http://x/api/studio/session/start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })); };
const total = async () => (await ledgerBalance(d, "u1")).total;

describe("signed Paystack webhook → credits → Studio gate", () => {
  it("zero credits cannot start a session", async () => {
    const res = await startSession();
    expect(res.status).toBe(402);
    expect(await d.select().from(studioSessions)).toHaveLength(0);
  });

  it("a bad or missing signature is refused and grants nothing", async () => {
    expect((await post("nope")).status).toBe(401);
    expect((await post("")).status).toBe(401);
    expect(await total()).toBe(0);
    expect(globalThis.fetch).not.toHaveBeenCalled(); // not even verified with Paystack
  });

  it("a good signature grants the top-up once; a replay does not double-grant; the credits unlock the Studio", async () => {
    expect((await post(sign(body))).status).toBe(200);
    expect(await total()).toBe(1000);
    const [p] = await d.select().from(payments).where(eq(payments.reference, REF));
    expect(p.status).toBe("success");

    expect((await post(sign(body))).status).toBe(200); // Paystack redelivers
    expect(await total()).toBe(1000);

    const res = await startSession();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ remaining: 1000 });
    expect(await d.select().from(studioSessions)).toHaveLength(1);
  });

  it("a paid amount that differs from the price is rejected and grants nothing", async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ status: true, data: { reference: REF, status: "success", amount: 100, currency: "NGN", metadata: { userId: "u1", product: "TOPUP_1K" } } })) as typeof fetch;
    expect((await post(sign(body))).status).toBe(200);
    expect(await total()).toBe(0);
  });
});
