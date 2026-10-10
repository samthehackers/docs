/**
 * Seed: promotes an existing Supabase Auth user to admin (`app_metadata.role = "admin"`, settable only with the secret
 * key) and mirrors it in the database. Plans live in lib/plans.ts (config, not rows), so there is nothing else to insert.
 *
 *   npm run db:seed -- you@example.com
 *
 * Needs SUPABASE_URL + SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) and a database URL in .env.local.
 * The same thing in SQL (Supabase SQL editor) is in GO_LIVE.md.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { provisionUser } from "@/lib/users";
import { getPlans } from "@/lib/plan-config";
import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const email = process.argv[2]?.toLowerCase();
  if (!email) throw new Error("usage: npm run db:seed -- <admin-email>");
  const sb = createAdminClient();
  let found: { id: string; email?: string; app_metadata: Record<string, unknown>; user_metadata: Record<string, unknown> } | undefined;
  for (let page = 1; !found; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(error.message);
    found = data.users.find((u) => u.email?.toLowerCase() === email);
    if (data.users.length < 200) break;
  }
  if (!found) throw new Error(`No Supabase Auth user with email ${email}. Sign up first, then re-run.`);
  const { error } = await sb.auth.admin.updateUserById(found.id, { app_metadata: { ...found.app_metadata, role: "admin" } });
  if (error) throw new Error(error.message);
  const meta = found.user_metadata as { full_name?: string; name?: string; avatar_url?: string };
  await provisionUser({ id: found.id, email, name: meta.full_name ?? meta.name ?? "", avatarUrl: meta.avatar_url ?? null });
  await db().update(users).set({ role: "admin" }).where(eq(users.id, found.id));
  console.log(`admin: ${email} (${found.id}).`);
  console.log("plans:", Object.entries(await getPlans()).map(([k, v]) => `${k}=${v.monthlyCredits}cr`).join(", "));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
