/**
 * Deleting an account must not leave a subscription billing a deleted account. The real DELETE /api/account route and
 * deleteAccount on an in-memory Postgres; the payment provider's cancel call, storage and the sign-in provider are faked.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const h = vi.hoisted(() => ({ db: null as unknown, me: "A" as string | null, cancel: vi.fn(async (_c: string, _t?: string) => {}), files: vi.fn(async (_u: string) => {}) }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: h.me }), clerkClient: async () => ({ users: { deleteUser: async () => {} } }) }));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));
vi.mock("@/lib/payments", () => ({ getProvider: () => ({ cancelSubscription: h.cancel }) }));
vi.mock("@/lib/storage", async (orig) => ({ ...(await orig<typeof import("@/lib/storage")>()), deleteUserFiles: h.files }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { auditLog, subscriptions, users } from "@/db/schema";
import { deleteAccount } from "@/lib/users";
import * as account from "@/app/api/account/route";

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);
beforeEach(async () => {
  h.cancel.mockReset(); h.cancel.mockImplementation(async () => {}); h.files.mockClear();
  await d.execute(sql`truncate users, subscriptions, payments, webhook_events, credit_ledger, audit_log, notifications restart identity cascade`);
  await d.insert(users).values({ id: "A", email: "a@x.co", name: "A", plan: "PRO" });
  await d.insert(subscriptions).values({ userId: "A", provider: "paystack", providerSubId: "SUB_A", emailToken: "tok-secret", plan: "PRO", status: "active" });
});
const del = () => account.DELETE(new Request("http://x/api/account", { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) }));
const exists = async () => (await d.select().from(users).where(eq(users.id, "A"))).length === 1;

describe("deleting your own account while the provider refuses to cancel the subscription", () => {
  it("aborts before deleting anything and answers 502 with a clear message", async () => {
    h.cancel.mockRejectedValueOnce(new Error("paystack 500"));
    const r = await del();
    expect(r.status).toBe(502);
    expect((await r.json()).error).toMatch(/couldn't cancel your Pro subscription.*not deleted/i);
    expect(await exists()).toBe(true);
    expect(h.files).not.toHaveBeenCalled();
    expect((await d.select().from(subscriptions))[0].status).toBe("active");
  });
  it("goes ahead when the cancel succeeds", async () => {
    expect((await del()).status).toBe(200);
    expect(h.cancel).toHaveBeenCalledWith("SUB_A", "tok-secret");
    expect(await exists()).toBe(false);
  });
});

describe("the sign-in provider's user.deleted webhook (the login is already gone)", () => {
  it("deletes anyway and leaves an audit entry naming the subscription for manual cancellation, without the token", async () => {
    h.cancel.mockRejectedValueOnce(new Error("paystack 500"));
    await deleteAccount("A", { deleteClerk: false });
    expect(await exists()).toBe(false);
    const [a] = (await d.select().from(auditLog)).filter((x) => x.action === "account_delete.subscription_cancel_failed");
    expect(JSON.stringify(a.meta)).toContain("SUB_A");
    expect(JSON.stringify(a.meta)).not.toContain("tok-secret");
  });
});
