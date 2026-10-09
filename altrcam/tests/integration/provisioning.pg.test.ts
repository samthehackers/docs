/**
 * Account provisioning racing itself on a REAL PostgreSQL through the production driver: the Clerk webhook (svix-signed, through
 * the real route) against the lazy path from the first signed-in page, and duplicate webhook deliveries against each other. The
 * in-memory test database runs every transaction on one connection, so it cannot show what concurrent transactions do; this can.
 * The rule under test: one users row on FREE, one sign-up grant, one recorded delivery, whatever the interleaving.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/an_empty_database npm run test:integration
 *
 * Skipped (not failed) when TEST_DATABASE_URL is unset. It TRUNCATES the app's tables, so use a scratch database.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq, sql } from "drizzle-orm";
import { Webhook } from "svix";

vi.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ users: { deleteUser: async () => {} } }), auth: async () => ({ userId: null }) }));

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;
const SECRET = `whsec_${Buffer.from("integration-clerk-webhook-secret").toString("base64")}`;
if (URL_) { process.env.DATABASE_URL = URL_; process.env.CLERK_WEBHOOK_SECRET = SECRET; }

import { db } from "@/lib/db";
import { creditLedger, users, webhookEvents } from "@/db/schema";
import { ensureUserRow, provisionUser } from "@/lib/users";
import { DEFAULT_PLANS } from "@/lib/plans";
import { invalidatePlanCache } from "@/lib/plan-config";
import { POST as clerkWebhook } from "@/app/api/webhooks/clerk/route";

const ROUNDS = 12;
const GRANT = DEFAULT_PLANS.FREE.monthlyCredits;
const profile = (id: string) => ({ id, email: `${id}@example.com`, name: id });
function signed(msgId: string, id: string) {
  const body = JSON.stringify({ type: "user.created", data: { id, first_name: id, primary_email_address_id: "e1", email_addresses: [{ id: "e1", email_address: `${id}@example.com` }] } });
  const at = new Date();
  return new Request("http://x/api/webhooks/clerk", {
    method: "POST", body,
    headers: { "svix-id": msgId, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": new Webhook(SECRET).sign(msgId, at, body) },
  });
}
async function state(id: string) {
  const [u] = await db().select().from(users).where(eq(users.id, id));
  const grants = await db().select().from(creditLedger).where(eq(creditLedger.userId, id));
  return { plan: u?.plan, monthly: u?.creditsMonthly, grants: grants.length, granted: grants.reduce((a, g) => a + g.delta, 0) };
}

suite("provisioning races (real PostgreSQL)", () => {
  let admin: ReturnType<typeof postgres>;
  beforeAll(async () => { admin = postgres(URL_!, { max: 1, prepare: false }); await migrate(drizzle(admin), { migrationsFolder: "db/migrations" }); });
  afterAll(async () => { await admin?.end(); });
  beforeEach(async () => {
    invalidatePlanCache();
    await db().execute(sql`truncate users, webhook_events, credit_ledger, audit_log, notifications, plan_config restart identity cascade`);
  });

  it("the webhook and the first signed-in page at the same moment: one row, one grant", async () => {
    for (let n = 0; n < ROUNDS; n++) {
      const id = `race_${n}`;
      // Alternate which one starts first.
      let hook: Promise<Response>, page: Promise<unknown>;
      if (n % 2) { hook = clerkWebhook(signed(`msg_${n}`, id)); page = ensureUserRow(id, async () => profile(id)); }
      else { page = ensureUserRow(id, async () => profile(id)); hook = clerkWebhook(signed(`msg_${n}`, id)); }
      const [res, row] = await Promise.all([hook, page]);
      expect(res.status, `round ${n}`).toBe(200);
      expect(row, `round ${n}`).toBeTruthy();
      expect(await state(id), `round ${n}`).toEqual({ plan: "FREE", monthly: GRANT, grants: 1, granted: GRANT });
    }
    expect(await db().select().from(webhookEvents)).toHaveLength(ROUNDS); // every delivery recorded once
  }, 90_000);

  it("the same delivery arriving several times at once: one grant, one recorded event", async () => {
    for (let n = 0; n < ROUNDS; n++) {
      const id = `dup_${n}`, ev = { provider: "clerk", eventId: `clerk:msg_dup_${n}`, type: "user.created" };
      const created = await Promise.all([provisionUser(profile(id), db(), ev), provisionUser(profile(id), db(), ev), provisionUser(profile(id), db())]);
      expect(created.filter(Boolean), `round ${n}`).toHaveLength(1);
      expect(await state(id), `round ${n}`).toEqual({ plan: "FREE", monthly: GRANT, grants: 1, granted: GRANT });
      expect(await db().select().from(webhookEvents).where(eq(webhookEvents.eventId, ev.eventId))).toHaveLength(1);
    }
  }, 90_000);

  it("a replayed delivery through the real route after the fact grants nothing more", async () => {
    const req = () => signed("msg_replay", "replay_user");
    expect((await clerkWebhook(req())).status).toBe(200);
    expect((await clerkWebhook(req())).status).toBe(200);
    expect(await state("replay_user")).toEqual({ plan: "FREE", monthly: GRANT, grants: 1, granted: GRANT });
  });
});
