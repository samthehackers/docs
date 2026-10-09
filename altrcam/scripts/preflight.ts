/**
 * Pre-launch check against your REAL credentials. Read-only: it creates, changes and deletes nothing.
 *
 *   npm run preflight            # uses .env.local
 *
 * Exit code 1 if anything FAILs. WARN means "works, but look at it".
 */
import postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { Redis } from "@upstash/redis";
import { createClerkClient } from "@clerk/backend";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";
import { env, type Env } from "@/lib/env";

type Level = "PASS" | "FAIL" | "WARN" | "SKIP";
const rows: { name: string; level: Level; note: string }[] = [];
const rec = (name: string, level: Level, note = "") => { rows.push({ name, level, note }); };

async function check(name: string, fn: () => Promise<[Level, string] | void>) {
  try {
    const r = await fn();
    if (r) rec(name, r[0], r[1]); else rec(name, "PASS");
  } catch (e) {
    rec(name, "FAIL", e instanceof Error ? e.message : String(e));
  }
}

// Derived from the real schema so this can never drift from the migrations.
const EXPECTED_TABLES = (Object.values(schema) as unknown[]).filter((v): v is PgTable => is(v, PgTable)).map((t) => getTableName(t));

async function main() {
  let e: Env | null = null;
  await check("Environment variables validate", async () => { e = env(); });
  if (!e) {
    for (const n of ["Database", "Row-level security", "Storage bucket", "Clerk key", "Paystack plans", "NOWPayments key", "Resend sender domain", "Upstash Redis"]) rec(n, "SKIP", "needs a valid environment");
    return report();
  }
  const cfg: Env = e;

  await check("Database reachable, all tables present", async () => {
    const sql = postgres(cfg.DATABASE_URL, { prepare: false, max: 1 });
    try {
      const t = await sql<{ table_name: string }[]>`select table_name from information_schema.tables where table_schema = 'public'`;
      const have = new Set(t.map((r) => r.table_name));
      const missing = EXPECTED_TABLES.filter((x) => !have.has(x));
      if (missing.length) return ["FAIL", `missing tables: ${missing.join(", ")} (run npm run db:migrate)`];
    } finally { await sql.end(); }
  });

  await check("Row-level security enabled on every table", async () => {
    const sql = postgres(cfg.DATABASE_URL, { prepare: false, max: 1 });
    try {
      const r = await sql<{ relname: string }[]>`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname = any(${EXPECTED_TABLES})`;
      if (r.length) return ["FAIL", `RLS off on: ${r.map((x) => x.relname).join(", ")}`];
    } finally { await sql.end(); }
  });

  await check("Storage bucket 'uploads' exists and is private", async () => {
    const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data, error } = await sb.storage.getBucket("uploads");
    if (error || !data) return ["FAIL", "bucket 'uploads' not found. Create it in Supabase → Storage as a PRIVATE bucket"];
    if (data.public) return ["FAIL", "bucket 'uploads' is PUBLIC. Make it private; users' images would be world-readable"];
  });

  await check("Clerk secret key works", async () => {
    await createClerkClient({ secretKey: cfg.CLERK_SECRET_KEY }).users.getUserList({ limit: 1 });
  });

  await check("Paystack plans exist and match your prices", async () => {
    const plans: [string, string, number][] = [["monthly", cfg.PAYSTACK_PLAN_PRO_MONTHLY, cfg.PRICE_PRO_MONTHLY], ["yearly", cfg.PAYSTACK_PLAN_PRO_YEARLY, cfg.PRICE_PRO_YEARLY]];
    const bad: string[] = [];
    for (const [label, code, price] of plans) {
      const r = await fetch(`https://api.paystack.co/plan/${encodeURIComponent(code)}`, { headers: { Authorization: `Bearer ${cfg.PAYSTACK_SECRET_KEY}` } });
      const j = (await r.json().catch(() => ({}))) as { status?: boolean; data?: { amount: number; currency: string } };
      if (!r.ok || !j.status || !j.data) { bad.push(`${label}: plan ${code} not found`); continue; }
      if (j.data.amount !== price || j.data.currency.toUpperCase() !== cfg.PRICE_CURRENCY) bad.push(`${label}: plan is ${j.data.amount} ${j.data.currency} but PRICE is ${price} ${cfg.PRICE_CURRENCY} (renewals would be REJECTED)`);
    }
    if (bad.length) return ["FAIL", bad.join("; ")];
  });

  await check("NOWPayments API key works", async () => {
    const r = await fetch("https://api.nowpayments.io/v1/status", { headers: { "x-api-key": cfg.NOWPAYMENTS_API_KEY } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });

  await check("Resend: sender domain verified", async () => {
    const m = cfg.EMAIL_FROM.match(/<([^>]+)>/)?.[1] ?? cfg.EMAIL_FROM;
    const domain = m.split("@")[1];
    const r = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${cfg.RESEND_API_KEY}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}. Sending-only keys can't list domains; verify manually`);
    const j = (await r.json()) as { data?: { name: string; status: string }[] };
    const d = j.data?.find((x) => x.name === domain);
    if (!d) return ["FAIL", `domain ${domain} not added in Resend`];
    if (d.status !== "verified") return ["WARN", `domain ${domain} status is '${d.status}'`];
  });

  await check("Upstash Redis reachable", async () => {
    await new Redis({ url: cfg.UPSTASH_REDIS_REST_URL, token: cfg.UPSTASH_REDIS_REST_TOKEN }).ping();
  });

  await check("NEXT_PUBLIC_APP_URL is https and not localhost", async () => {
    const u = new URL(cfg.NEXT_PUBLIC_APP_URL);
    if (u.protocol !== "https:" || /localhost|127\.0\.0\.1/.test(u.hostname)) return ["WARN", `${cfg.NEXT_PUBLIC_APP_URL}: fine for local testing, wrong for production (webhooks, cookies, CSP)`];
  });

  await check("Support inbox configured", async () => {
    if (!process.env.NEXT_PUBLIC_SUPPORT_EMAIL) return ["WARN", "NEXT_PUBLIC_SUPPORT_EMAIL not set; Contact page shows support@altrcam.com. Make sure someone reads it"];
  });

  await check("Sign-up switch", async () => {
    if (cfg.SIGNUPS_OPEN !== "true") return ["WARN", 'SIGNUPS_OPEN is not "true", so the site says sign-up isn\'t open. Set it when you are ready (docs/SETUP.md)'];
  });

  rec("fal.ai signaling", "WARN", "cannot be checked here: verify with a live session (see GO_LIVE.md, step 'Verify fal signaling')");
  rec("Webhook URLs registered", "WARN", "cannot be checked here: Clerk, Paystack, NOWPayments dashboards (see GO_LIVE.md)");
  return report();
}

function report() {
  const icon: Record<Level, string> = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN", SKIP: "SKIP" };
  const w = Math.max(...rows.map((r) => r.name.length));
  for (const r of rows) console.log(`${icon[r.level]}  ${r.name.padEnd(w)}${r.note ? "  " + r.note : ""}`);
  const fails = rows.filter((r) => r.level === "FAIL").length;
  console.log(`\n${rows.filter((r) => r.level === "PASS").length} passed, ${fails} failed, ${rows.filter((r) => r.level === "WARN").length} to review`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
