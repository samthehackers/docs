/**
 * Audit of the fal token proxy (app/api/fal/proxy/route.ts), the only server route that uses FAL_KEY.
 *
 * It must: require Clerk auth AND an open studio session of the same user; mint only a token for the Lucy realtime
 * app, only at https://rest.fal.ai/tokens/, only POST, only for <= 300 s; forward nothing the caller chose beyond the
 * checked fields; and never return or log FAL_KEY. The real route handler, the real @fal-ai/server-proxy and a real
 * Postgres engine (PGlite) run here; Clerk is mocked and fal's token endpoint is a mocked fetch that records what it got.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ db: null as unknown, me: null as string | null }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: h.me }),
  currentUser: async () => null,
  clerkClient: async () => ({ users: { getUser: async () => ({ publicMetadata: {} }) } }),
  clerkMiddleware: () => () => {}, createRouteMatcher: () => () => false,
}));
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), db: () => h.db }));

import { testDb } from "./helpers";
import type { DB } from "@/lib/db";
import { studioSessions, users } from "@/db/schema";
import { FAL_APP, FAL_APP_ALIAS, FAL_APP_ALIASES } from "@/lib/fal/config";
import * as proxy from "@/app/api/fal/proxy/route";

const FAKE_KEY = "fakeKeyId-3c1e:fakeKeySecret-9b7d4f0a2e6c-DO-NOT-LEAK";
const MINE = "00000000-0000-4000-8000-0000000000a1";
const THEIRS = "00000000-0000-4000-8000-0000000000b2";
const ENDED = "00000000-0000-4000-8000-0000000000c3";
const TARGET = "https://rest.fal.ai/tokens/";
const GOOD_BODY = { allowed_apps: [FAL_APP_ALIAS], token_expiration: 120 };

let d: DB;
beforeAll(async () => { d = await testDb(); h.db = d; }, 60_000);

type Seen = { url: string; method?: string; headers: Record<string, string>; body: string };
let seen: Seen[] = [];
let reply: () => Response | Promise<Response>;
let logs: string[] = [];
beforeEach(async () => {
  process.env.FAL_KEY = FAKE_KEY;
  h.me = "u1";
  await d.execute(sql`truncate users, studio_sessions restart identity cascade`);
  await d.insert(users).values([{ id: "u1", email: "u1@x.co" }, { id: "u2", email: "u2@x.co" }]);
  await d.insert(studioSessions).values([
    { id: MINE, userId: "u1", maxSeconds: 60 },
    { id: THEIRS, userId: "u2", maxSeconds: 60 },
    { id: ENDED, userId: "u1", maxSeconds: 60, endedAt: new Date(), endReason: "user" },
  ]);
  seen = [];
  reply = () => new Response(JSON.stringify("short-lived-token"), { status: 200, headers: { "content-type": "application/json", "set-cookie": "fal_session=abc; Path=/", "x-fal-request-id": "r-1" } });
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), method: init?.method, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)])), body: String(init?.body ?? "") });
    return reply();
  }));
  logs = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
  }
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function call(o: { method?: string; target?: string | null; session?: string | null; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(o.headers ?? {}) };
  if (o.target !== null) headers["x-fal-target-url"] = o.target ?? TARGET;
  if (o.session !== null) headers["x-altrcam-session"] = o.session ?? MINE;
  const method = o.method ?? "POST";
  const req = new NextRequest("http://localhost/api/fal/proxy", { method, headers, ...(method === "GET" ? {} : { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body ?? GOOD_BODY) }) });
  const handler = (proxy as unknown as Record<string, (r: NextRequest) => Promise<Response>>)[method];
  return handler(req);
}
async function expectRefused(p: Promise<Response>, status: number) {
  const r = await p;
  expect(r.status).toBe(status);
  expect(seen, "fal was called").toEqual([]);
  return r;
}
const allHeaders = (r: Response) => [...r.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");

describe("the allowlisted app", () => {
  it("is exactly the Lucy realtime app id and the alias the pinned fal client derives from it", () => {
    expect(FAL_APP).toBe("decart/lucy-2-5/realtime");
    expect(FAL_APP_ALIASES).toEqual(["lucy-2-5", "decart/lucy-2-5/realtime"]);
    // @fal-ai/client mints realtime tokens with allowed_apps: [parseEndpointId(app).alias] (src/auth.js).
    const req = createRequire(import.meta.url);
    const { parseEndpointId } = req(path.resolve("node_modules/@fal-ai/client/src/utils.js")) as { parseEndpointId: (id: string) => { owner: string; alias: string; path?: string } };
    expect(parseEndpointId(FAL_APP)).toEqual({ owner: "decart", alias: FAL_APP_ALIAS, path: "realtime" });
  });
});

describe("happy path", () => {
  it("mints a token for a signed-in user with their own open session", async () => {
    const r = await call();
    expect(r.status).toBe(200);
    expect(await r.json()).toBe("short-lived-token");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ url: TARGET, method: "POST" });
    expect(seen[0].headers.authorization).toBe(`Key ${FAKE_KEY}`); // the one place the key goes: to fal, over https
  });
  it.each([[1], [120], [300]])("accepts a lifetime of %i s", async (n) => {
    expect((await call({ body: { allowed_apps: [FAL_APP_ALIAS], token_expiration: n } })).status).toBe(200);
  });
  it("accepts the full app id too (both entries of FAL_APP_ALIASES)", async () => {
    expect((await call({ body: { allowed_apps: [FAL_APP], token_expiration: 120 } })).status).toBe(200);
  });
});

describe("who may ask", () => {
  it("refuses a signed-out caller (401)", async () => { h.me = null; await expectRefused(call(), 401); });
  it.each([
    ["no session header", null],
    ["another user's open session", THEIRS],
    ["the caller's ended session", ENDED],
    ["an unknown id", "00000000-0000-4000-8000-0000000000ff"],
    ["garbage", "'; drop table users; --"],
  ])("refuses %s (403)", async (_n, session) => { await expectRefused(call({ session }), 403); });
});

describe("where the token is minted", () => {
  it.each([
    ["plain http (the key would cross the network in clear text)", "http://rest.fal.ai/tokens/"],
    ["a query string", "https://rest.fal.ai/tokens/?x=1"],
    ["a fragment", "https://rest.fal.ai/tokens/#x"],
    ["another port", "https://rest.fal.ai:8443/tokens/"],
    ["credentials in the URL", "https://user:pw@rest.fal.ai/tokens/"],
    ["no trailing slash", "https://rest.fal.ai/tokens"],
    ["a sub-path", "https://rest.fal.ai/tokens/abc"],
    ["path traversal to storage", "https://rest.fal.ai/tokens/../storage/upload/initiate?storage_type=fal-cdn-v3"],
    ["fal storage", "https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3"],
    ["a model run", "https://fal.run/decart/lucy-2-5/realtime"],
    ["the queue", "https://queue.fal.run/fal-ai/flux/dev"],
    ["a look-alike host", "https://rest.fal.ai.evil.example/tokens/"],
    ["another host", "https://evil.example/tokens/"],
    ["not a URL", "rest.fal.ai/tokens/"],
  ])("refuses %s (400)", async (_n, target) => { await expectRefused(call({ target }), 400); });
  it("refuses a missing target (400)", async () => { await expectRefused(call({ target: null }), 400); });
});

describe("which app, for how long", () => {
  it.each([
    ["another app", { allowed_apps: ["fal-ai/flux"], token_expiration: 120 }],
    ["Lucy plus another app", { allowed_apps: [FAL_APP_ALIAS, "fal-ai/flux"], token_expiration: 120 }],
    ["no app", { allowed_apps: [], token_expiration: 120 }],
    ["a string instead of a list", { allowed_apps: FAL_APP_ALIAS, token_expiration: 120 }],
    ["a different case", { allowed_apps: ["LUCY-2-5"], token_expiration: 120 }],
    ["a padded name", { allowed_apps: ["lucy-2-5 "], token_expiration: 120 }],
    ["a partial id", { allowed_apps: ["decart/lucy-2-5"], token_expiration: 120 }],
    ["a wildcard", { allowed_apps: ["*"], token_expiration: 120 }],
    ["missing", { token_expiration: 120 }],
  ])("refuses %s (400)", async (_n, body) => { await expectRefused(call({ body }), 400); });
  it.each([
    ["over 300 s", 301], ["an hour", 3600], ["zero", 0], ["negative", -1], ["fractional", 120.5],
    ["a string", "120"], ["a string over the limit", "100000"], ["null", null],
  ])("refuses a lifetime that is %s (400)", async (_n, token_expiration) => {
    await expectRefused(call({ body: { allowed_apps: [FAL_APP_ALIAS], token_expiration } }), 400);
  });
  it("refuses a missing lifetime (fal's default is not ours to guess) (400)", async () => {
    await expectRefused(call({ body: { allowed_apps: [FAL_APP_ALIAS] } }), 400);
  });
  it("refuses a lifetime that overflows to Infinity, and a body that is not JSON (400)", async () => {
    await expectRefused(call({ body: `{"allowed_apps":["${FAL_APP_ALIAS}"],"token_expiration":1e400}` }), 400);
    await expectRefused(call({ body: "not json" }), 400);
  });
});

describe("methods", () => {
  it.each(["GET", "PUT"])("refuses %s (405), even with a valid session", async (method) => {
    await expectRefused(call({ method }), 405);
  });
  it("exports no other method handlers (Next answers 405 for the rest)", () => {
    expect(Object.keys(proxy).filter((k) => /^[A-Z]+$/.test(k)).sort()).toEqual(["GET", "POST", "PUT"]);
  });
});

describe("what reaches fal: only the checked fields", () => {
  it("forwards exactly the validated body, and none of the caller's own x-fal-* headers", async () => {
    const r = await call({
      body: { allowed_apps: [FAL_APP_ALIAS], token_expiration: 120, extra: "smuggled", allowed_apps_2: ["fal-ai/flux"] },
      headers: { "x-fal-queue-priority": "high", "x-fal-runner-hint": "smuggled", "x-fal-target-url-2": "https://evil.example/" },
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(seen[0].body)).toEqual({ allowed_apps: [FAL_APP_ALIAS], token_expiration: 120 });
    expect(Object.keys(seen[0].headers).filter((k) => k.startsWith("x-fal-") && k !== "x-fal-target-url" && k !== "x-fal-client-proxy")).toEqual([]);
  });
  it("uses FAL_KEY, never a caller's Authorization header (which could be their Clerk session token)", async () => {
    const r = await call({ headers: { authorization: "Bearer callers-clerk-session-jwt" } });
    expect(r.status).toBe(200);
    expect(seen[0].headers.authorization).toBe(`Key ${FAKE_KEY}`);
    expect(JSON.stringify(seen)).not.toContain("callers-clerk-session-jwt");
  });
  it("answers 503 and calls nothing when FAL_KEY is not set (instead of sending `Key undefined`)", async () => {
    delete process.env.FAL_KEY;
    await expectRefused(call(), 503);
  });
});

describe("FAL_KEY is never returned or logged", () => {
  const scenarios: [string, () => Response | Promise<Response>][] = [
    ["a token", () => new Response(JSON.stringify("short-lived-token"), { status: 200, headers: { "content-type": "application/json" } })],
    ["fal refusing the key", () => new Response(JSON.stringify({ detail: "Invalid key" }), { status: 401, headers: { "content-type": "application/json", "www-authenticate": "Key" } })],
    ["fal failing", () => new Response("upstream exploded", { status: 502, headers: { "content-type": "text/plain" } })],
    ["fal echoing our request back (worst case)", () => new Response(JSON.stringify({ youSent: `Key ${FAKE_KEY}` }), { status: 200, headers: { "content-type": "application/json", "x-echo-authorization": `Key ${FAKE_KEY}` } })],
    ["fal unreachable", () => { throw new TypeError(`fetch failed (Authorization: Key ${FAKE_KEY})`); }],
  ];
  it.each(scenarios)("when the upstream answer is %s", async (_n, upstream) => {
    reply = upstream;
    const r = await call();
    const body = await r.text();
    expect(body).not.toContain(FAKE_KEY);
    expect(allHeaders(r)).not.toContain(FAKE_KEY);
    expect(logs.join("\n")).not.toContain(FAKE_KEY);
  });
  it("in any refusal either", async () => {
    for (const p of [call({ target: "http://rest.fal.ai/tokens/" }), call({ session: THEIRS }), call({ method: "GET" }), call({ body: { allowed_apps: ["x"], token_expiration: 1 } })]) {
      const r = await p;
      expect(await r.text()).not.toContain(FAKE_KEY);
      expect(allHeaders(r)).not.toContain(FAKE_KEY);
    }
    expect(logs.join("\n")).not.toContain(FAKE_KEY);
  });
  it("passes on none of fal's own headers (no cookies set on our domain), and the token is not cacheable", async () => {
    const r = await call();
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-fal-request-id")).toBeNull();
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("content-type")).toBe("application/json");
  });
});
