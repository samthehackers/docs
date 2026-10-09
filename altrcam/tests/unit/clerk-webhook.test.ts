/**
 * The real Clerk webhook route (app/api/webhooks/clerk/route.ts) and the lazy path (ensureUserRow), against a real in-memory
 * Postgres with the production migrations. Requests are signed with svix exactly as Clerk signs them.
 * What matters: a new account gets its row on FREE and its sign-up credits exactly once, however many times the webhook is
 * delivered and whichever of the webhook and the first signed-in page gets there first; an unsigned request changes nothing.
 * The same races on a real PostgreSQL server: tests/integration/provisioning.pg.test.ts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));
vi.mock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("@/lib/storage")>()), deleteUserFiles: async () => {} }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { creditLedger, users, webhookEvents } from "@/db/schema";
import { POST } from "@/app/api/webhooks/clerk/route";
import { ensureUserRow } from "@/lib/users";
import { DEFAULT_PLANS } from "@/lib/plans";
import { invalidatePlanCache } from "@/lib/plan-config";

const SECRET = `whsec_${Buffer.from("clerk-webhook-test-secret-bytes").toString("base64")}`;
const signer = new Webhook(SECRET);
const GRANT = DEFAULT_PLANS.FREE.monthlyCredits;

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);
beforeEach(async () => {
  process.env.CLERK_WEBHOOK_SECRET = SECRET;
  invalidatePlanCache();
  await d.execute(sql`truncate users, webhook_events, credit_ledger, audit_log, notifications, plan_config restart identity cascade`);
});

const clerkUser = (id: string) => ({
  id, first_name: "Ada", last_name: "Lovelace", username: null, image_url: "https://img.clerk.com/ada.png",
  primary_email_address_id: "idn_2", email_addresses: [{ id: "idn_1", email_address: "old@example.com" }, { id: "idn_2", email_address: `${id}@example.com` }],
});
/** A delivery as Clerk (through svix) sends it: the body, and headers signed over id + timestamp + body. */
function delivery(msgId: string, type: string, data: unknown, opts: { at?: Date; secret?: string } = {}) {
  const body = JSON.stringify({ type, object: "event", data });
  const at = opts.at ?? new Date();
  const sig = (opts.secret ? new Webhook(opts.secret) : signer).sign(msgId, at, body);
  return () => new Request("http://localhost/api/webhooks/clerk", {
    method: "POST", body,
    headers: { "content-type": "application/json", "svix-id": msgId, "svix-timestamp": String(Math.floor(at.getTime() / 1000)), "svix-signature": sig },
  });
}
const grants = async (id: string) => d.select().from(creditLedger).where(eq(creditLedger.userId, id));
const userRow = async (id: string) => (await d.select().from(users).where(eq(users.id, id)))[0];
const events = async () => d.select().from(webhookEvents);
const lazy = (id: string) => ensureUserRow(id, async () => ({ id, email: `${id}@example.com`, name: "Ada Lovelace" }));

describe("user.created", () => {
  it("creates the users row on FREE with the sign-up credits, and records the delivery", async () => {
    const res = await POST(delivery("msg_1", "user.created", clerkUser("user_1"))());
    expect(res.status).toBe(200);
    const u = await userRow("user_1");
    expect(u).toMatchObject({ plan: "FREE", email: "user_1@example.com", name: "Ada Lovelace", avatarUrl: "https://img.clerk.com/ada.png", creditsMonthly: GRANT, creditsPurchased: 0 });
    const g = await grants("user_1");
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ delta: GRANT, bucket: "monthly", reason: "signup_grant" });
    expect(await events()).toEqual([expect.objectContaining({ provider: "clerk", eventId: "clerk:msg_1", type: "user.created", payload: null })]);
  });

  it("a replayed delivery is a no-op: one row, one grant, one recorded event", async () => {
    const req = delivery("msg_1", "user.created", clerkUser("user_1"));
    for (let n = 0; n < 3; n++) expect((await POST(req())).status).toBe(200);
    expect(await grants("user_1")).toHaveLength(1);
    expect((await userRow("user_1")).creditsMonthly).toBe(GRANT);
    expect(await events()).toHaveLength(1);
  });

  it("concurrent copies of the same delivery still grant once", async () => {
    const req = delivery("msg_9", "user.created", clerkUser("user_9"));
    const rs = await Promise.all([POST(req()), POST(req()), POST(req())]);
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await grants("user_9")).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("a second, different delivery for the same user (a manual resend) grants nothing more", async () => {
    await POST(delivery("msg_1", "user.created", clerkUser("user_1"))());
    await POST(delivery("msg_2", "user.created", clerkUser("user_1"))());
    expect(await grants("user_1")).toHaveLength(1);
  });

  it("a replay after the account was deleted does not bring it back with fresh credits", async () => {
    const created = delivery("msg_1", "user.created", clerkUser("user_1"));
    await POST(created());
    expect((await POST(delivery("msg_2", "user.deleted", { id: "user_1", deleted: true })())).status).toBe(200);
    expect(await userRow("user_1")).toBeUndefined();
    await POST(created());
    expect(await userRow("user_1")).toBeUndefined();
    expect(await grants("user_1")).toHaveLength(0);
  });

  it("a failure is not recorded, so Clerk's retry is processed (500, then 200 with the grant)", async () => {
    const broken = delivery("msg_5", "user.created", { ...clerkUser("user_5"), id: null });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(broken())).status).toBe(500);
    err.mockRestore();
    expect(await events()).toHaveLength(0); // the event row rolled back with the failed provisioning
    expect((await POST(delivery("msg_5", "user.created", clerkUser("user_5"))())).status).toBe(200);
    expect(await grants("user_5")).toHaveLength(1);
  });
});

describe("the webhook and the lazy path (first signed-in page) together", () => {
  it("webhook first, then the first page: one grant", async () => {
    await POST(delivery("msg_1", "user.created", clerkUser("user_1"))());
    expect((await lazy("user_1"))?.creditsMonthly).toBe(GRANT);
    expect(await grants("user_1")).toHaveLength(1);
  });
  it("first page first (webhook late), then the webhook: one grant, and the late delivery is still recorded", async () => {
    expect((await lazy("user_2"))?.creditsMonthly).toBe(GRANT);
    expect((await POST(delivery("msg_2", "user.created", clerkUser("user_2"))())).status).toBe(200);
    expect(await grants("user_2")).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });
  it("racing each other: one grant, in either order", async () => {
    for (let n = 0; n < 6; n++) {
      const id = `race_${n}`, req = delivery(`msg_r${n}`, "user.created", clerkUser(id));
      const [a, b] = n % 2 ? [lazy(id), POST(req())] : [POST(req()), lazy(id)];
      await Promise.all([a, b]);
      expect(await grants(id), id).toHaveLength(1);
      expect((await userRow(id)).creditsMonthly, id).toBe(GRANT);
    }
  });
});

describe("signature verification (svix)", () => {
  const ok = delivery("msg_1", "user.created", clerkUser("user_1"));
  const expectNothingWritten = async () => { expect(await userRow("user_1")).toBeUndefined(); expect(await events()).toHaveLength(0); };

  it("a bad signature is 401 and changes nothing", async () => {
    const req = ok();
    req.headers.set("svix-signature", "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect((await POST(req)).status).toBe(401);
    await expectNothingWritten();
  });
  it("a body changed after signing is 401", async () => {
    const good = ok();
    const tampered = new Request(good.url, { method: "POST", headers: good.headers, body: JSON.stringify({ type: "user.created", data: clerkUser("user_666") }) });
    expect((await POST(tampered)).status).toBe(401);
    expect(await userRow("user_666")).toBeUndefined();
  });
  it("a request signed with another secret, or with no svix headers at all, is 401", async () => {
    expect((await POST(delivery("msg_1", "user.created", clerkUser("user_1"), { secret: `whsec_${Buffer.from("someone-else").toString("base64")}` })())).status).toBe(401);
    expect((await POST(new Request("http://localhost/api/webhooks/clerk", { method: "POST", body: "{}" }))).status).toBe(401);
    await expectNothingWritten();
  });
  it("a correctly signed but old delivery (outside svix's 5-minute window) is 401", async () => {
    expect((await POST(delivery("msg_1", "user.created", clerkUser("user_1"), { at: new Date(Date.now() - 10 * 60_000) })())).status).toBe(401);
    await expectNothingWritten();
  });
  it("with CLERK_WEBHOOK_SECRET unset everything is 401 (svix refuses an empty key)", async () => {
    delete process.env.CLERK_WEBHOOK_SECRET;
    expect((await POST(ok())).status).toBe(401);
    await expectNothingWritten();
  });
});
