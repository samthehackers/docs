/**
 * /admin/diagnostics and its diagnostics session, gated exactly like the admin console (tests/unit/admin-gate.test.ts):
 * the page and every function behind it check the role themselves, so a non-admin gets nothing even without the layout.
 *
 * The diagnostics session is what lets the check mint a fal token through /api/fal/proxy, so it is also tested as an
 * abuse surface: non-admins cannot create or end one, cannot use an admin's one at the proxy, it bills nothing whatever
 * meters it, and its end route cannot be used to close a normal (billed) Studio session for free.
 *
 * Real route handlers and a real Postgres engine (PGlite); Clerk is mocked; fal's token endpoint is a mocked fetch.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import * as React from "react";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ db: null as unknown, me: null as string | null, admins: new Set<string>() }));

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: h.me }),
  currentUser: async () => null,
  clerkClient: async () => ({ users: { getUser: async (id: string) => ({ publicMetadata: { role: h.admins.has(id) ? "admin" : "user" } }) } }),
  clerkMiddleware: () => () => {}, createRouteMatcher: () => () => false,
}));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { auditLog, studioSessions, users } from "@/db/schema";
import { grantCredits, ledgerBalance } from "@/lib/credits";
import { closeOpenSessions, meterSession, sweepStaleSessions } from "@/lib/metering";
import { DIAGNOSTICS_END_REASON, diagnosticsOverview } from "@/lib/admin-diagnostics";
import { sessionEndLabel } from "@/lib/account-summary";
import Diagnostics from "@/app/(admin)/admin/diagnostics/page";
import * as startRoute from "@/app/api/admin/diagnostics/session/route";
import * as endRoute from "@/app/api/admin/diagnostics/session/end/route";
import * as proxy from "@/app/api/fal/proxy/route";

let d: DB;
beforeAll(async () => {
  (globalThis as { React?: unknown }).React = React;
  d = await testDb(); h.db = d;
}, 60_000);

const NORMAL = "00000000-0000-4000-8000-000000000042";
let upstream: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  process.env.FAL_KEY = "fal-key-for-tests";
  h.me = null; h.admins = new Set(["boss", "boss2"]);
  await d.execute(sql`truncate users, credit_ledger, audit_log, notifications, studio_sessions restart identity cascade`);
  await d.insert(users).values([
    { id: "boss", email: "boss@x.co", name: "Boss" }, { id: "boss2", email: "boss2@x.co", name: "Boss Two" },
    { id: "plain", email: "plain@x.co", name: "Plain" },
  ]);
  for (const u of ["boss", "boss2", "plain"]) await grantCredits(d, u, 1000, "monthly", "seed");
  // fal's token endpoint, behind the proxy.
  upstream = vi.fn(async () => new Response(JSON.stringify("fal-short-lived-token"), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", upstream);
});
afterEach(() => { vi.unstubAllGlobals(); });

const redirectsTo = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return String((e as { digest?: string }).digest ?? e); }
  return "did not throw";
};
const post = (url: string, body: unknown) => new Request(`http://x${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const start = (as: string | null, body: unknown = {}) => { h.me = as; return startRoute.POST(post("/api/admin/diagnostics/session", body)); };
const end = (as: string | null, body: unknown) => { h.me = as; return endRoute.POST(post("/api/admin/diagnostics/session/end", body)); };
const tokenRequest = (as: string, sessionId: string) => {
  h.me = as;
  return proxy.POST(new NextRequest("http://x/api/fal/proxy", {
    method: "POST",
    headers: { "content-type": "application/json", "x-fal-target-url": "https://rest.fal.ai/tokens/", "x-altrcam-session": sessionId },
    body: JSON.stringify({ allowed_apps: ["lucy-2-5"], token_expiration: 120 }),
  }));
};
const rows = () => d.select().from(studioSessions);
const row = async (id: string) => (await d.select().from(studioSessions).where(eq(studioSessions.id, id)))[0];
const balance = async (u: string) => (await ledgerBalance(d, u)).total;
const newDiag = async (as = "boss") => {
  const r = await start(as, { prompt: "a test" });
  expect(r.status).toBe(200);
  return ((await r.json()) as { sessionId: string }).sessionId;
};

describe("the /admin/diagnostics page and its data", () => {
  it("sends a signed-in non-admin to the dashboard, from the page and from the data function called directly", async () => {
    h.me = "plain";
    expect(await redirectsTo(Diagnostics())).toMatch(/NEXT_REDIRECT.*\/dashboard/);
    expect(await redirectsTo(diagnosticsOverview())).toMatch(/NEXT_REDIRECT.*\/dashboard/);
  });
  it("sends a signed-out visitor to sign in", async () => {
    h.me = null;
    expect(await redirectsTo(Diagnostics())).toMatch(/NEXT_REDIRECT.*\/sign-in/);
    expect(await redirectsTo(diagnosticsOverview())).toMatch(/NEXT_REDIRECT.*\/sign-in/);
  });
  it("renders for an admin, with recorded results", async () => {
    await d.insert(auditLog).values({ actorId: "boss", action: "diagnostics.end", target: "s", meta: { pass: true, fps: 24 } });
    h.me = "boss";
    expect(await Diagnostics()).toBeTruthy();
    const o = await diagnosticsOverview();
    expect(o).toMatchObject({ configured: true, app: "decart/lucy-2-5/realtime" });
    expect(o.recent.map((a) => a.meta)).toEqual([{ pass: true, fps: 24 }]);
  });
  it("runs no database queries of its own, so every read goes through a function that checks the role", () => {
    const src = readFileSync(path.resolve("app/(admin)/admin/diagnostics/page.tsx"), "utf8");
    expect(src).not.toMatch(/\.from\(|\.select\(|\.insert\(|\.update\(|\.delete\(|db\(\)/);
    expect(src).toMatch(/await requireAdminPage\(\);\s*const o = await diagnosticsOverview\(\)/);
  });
  it("is linked from the admin console", () => {
    expect(readFileSync(path.resolve("app/(admin)/admin/page.tsx"), "utf8")).toContain('href="/admin/diagnostics"');
  });
});

describe("creating a diagnostics session", () => {
  it("is refused to a signed-out visitor (401) and to a signed-in non-admin (403), and creates nothing", async () => {
    expect((await start(null)).status).toBe(401);
    expect((await start("plain")).status).toBe(403);
    expect(await rows()).toEqual([]);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("says so when fal is not configured (503) instead of creating a row", async () => {
    delete process.env.FAL_KEY;
    const r = await start("boss");
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ code: "unavailable" });
    expect(await rows()).toEqual([]);
  });
  it("gives an admin a labelled, unbillable row and an audit record", async () => {
    const id = await newDiag();
    const s = await row(id);
    expect(s).toMatchObject({ userId: "boss", maxSeconds: 0, secondsBilled: 0, endedAt: null, settings: { diagnostics: true, prompt: "[diagnostics] a test" } });
    const audit = await d.select().from(auditLog);
    expect(audit.map((a) => [a.actorId, a.action, a.target])).toEqual([["boss", "diagnostics.start", id]]);
  });
  it("keeps at most one diagnostics row open per admin, and never touches the admin's own Studio session", async () => {
    await d.insert(studioSessions).values({ id: NORMAL, userId: "boss", maxSeconds: 1800 });
    const first = await newDiag();
    const second = await newDiag();
    expect((await row(first)).endReason).toBe(DIAGNOSTICS_END_REASON);
    expect((await row(second)).endedAt).toBeNull();
    expect((await row(NORMAL)).endedAt).toBeNull();
    expect(await balance("boss")).toBe(1000);
  });
  it("rejects an oversized prompt", async () => {
    expect((await start("boss", { prompt: "x".repeat(501) })).status).toBe(400);
  });
});

describe("the token proxy and a diagnostics session", () => {
  it("mints a token for the admin who owns it", async () => {
    const id = await newDiag();
    const r = await tokenRequest("boss", id);
    expect(r.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
  it("refuses a non-admin, or another admin, who presents its id: the row is not theirs", async () => {
    const id = await newDiag();
    expect((await tokenRequest("plain", id)).status).toBe(403);
    expect((await tokenRequest("boss2", id)).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });
  it("refuses once it has ended", async () => {
    const id = await newDiag();
    expect((await end("boss", { sessionId: id })).status).toBe(200);
    expect((await tokenRequest("boss", id)).status).toBe(403);
  });
});

describe("billing: a diagnostics session never costs credits", () => {
  const later = (s: number) => new Date(Date.now() + s * 1000);
  it("whatever meters it: an end, a heartbeat-style meter, the stale sweep, or the admin's next Studio start", async () => {
    const a = await newDiag();
    expect(await meterSession(a, "boss", { now: later(120) })).toMatchObject({ secondsBilled: 0, continue: false });
    const b = await newDiag();
    await closeOpenSessions("boss", later(10)); // a Studio start within the stale window: "superseded"
    const c = await newDiag();
    await sweepStaleSessions(later(600));
    for (const id of [a, b, c]) expect((await row(id)).secondsBilled, id).toBe(0);
    expect(await balance("boss")).toBe(1000);
  });
  it("is ended by its own route without metering, labelled for the admin's history", async () => {
    const id = await newDiag();
    const r = await end("boss", { sessionId: id, result: { pass: false, failureCode: "answer_timeout", timeToFirstFrameMs: null, fps: null, rttMs: null } });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ended: true, alreadyEnded: false });
    expect(await row(id)).toMatchObject({ endReason: "diagnostics", secondsBilled: 0 });
    expect(sessionEndLabel("diagnostics")).toBe("Admin diagnostics check (not billed)");
    const ends = await d.select().from(auditLog).where(eq(auditLog.action, "diagnostics.end"));
    expect(ends.map((a) => [a.actorId, a.target, a.meta])).toEqual([["boss", id, { pass: false, failureCode: "answer_timeout", timeToFirstFrameMs: null, fps: null, rttMs: null }]]);
    expect(await balance("boss")).toBe(1000);
  });
  it("records one result per check: a second end is fine without a result and refused (409) with one", async () => {
    const id = await newDiag();
    const result = { pass: true, failureCode: null, timeToFirstFrameMs: 2000, fps: 24, rttMs: 40 };
    expect((await end("boss", { sessionId: id, result })).status).toBe(200);
    const beacon = await end("boss", { sessionId: id });
    expect(await beacon.json()).toEqual({ ended: true, alreadyEnded: true });
    const forged = await end("boss", { sessionId: id, result: { ...result, fps: 60 } });
    expect(forged.status).toBe(409);
    expect(await forged.json()).toMatchObject({ code: "already_ended" });
    const ends = await d.select().from(auditLog).where(and(eq(auditLog.action, "diagnostics.end"), eq(auditLog.target, id)));
    expect(ends.map((a) => a.meta)).toEqual([result]);
  });
});

describe("ending: only the admin's own diagnostics row", () => {
  it("is refused to a signed-out visitor and to a non-admin, and the row stays open", async () => {
    const id = await newDiag();
    expect((await end(null, { sessionId: id })).status).toBe(401);
    expect((await end("plain", { sessionId: id })).status).toBe(403);
    expect((await row(id)).endedAt).toBeNull();
  });
  it("cannot close a normal Studio session unbilled, not even the admin's own", async () => {
    await d.insert(studioSessions).values({ id: NORMAL, userId: "boss", maxSeconds: 1800 });
    expect((await end("boss", { sessionId: NORMAL })).status).toBe(404);
    expect((await row(NORMAL)).endedAt).toBeNull();
  });
  it("a billed Studio row whose (caller-supplied) settings say diagnostics is still not a diagnostics row", async () => {
    // /api/studio/session/start stores the caller's settings as sent, so the flag alone proves nothing.
    await d.insert(studioSessions).values({ id: NORMAL, userId: "boss", maxSeconds: 1800, settings: { diagnostics: true, prompt: "x" } });
    expect((await end("boss", { sessionId: NORMAL })).status).toBe(404);
    await newDiag(); // "at most one open diagnostics row" must not close it either
    expect(await row(NORMAL)).toMatchObject({ endedAt: null, endReason: null });
  });
  it("cannot close another admin's diagnostics row", async () => {
    const id = await newDiag("boss2");
    expect((await end("boss", { sessionId: id })).status).toBe(404);
    expect((await row(id)).endedAt).toBeNull();
  });
  it("rejects a malformed id", async () => {
    expect((await end("boss", { sessionId: "not-a-uuid" })).status).toBe(400);
  });
});
