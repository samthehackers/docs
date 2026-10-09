/**
 * Seed: promotes an existing Clerk user to admin (Clerk publicMetadata.role = "admin") and mirrors it in the DB.
 * Plans live in lib/plans.ts (config, not rows), so there is nothing else to insert.
 *
 *   npm run db:seed -- you@example.com
 */
import { createClerkClient } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { provisionUser } from "@/lib/users";
import { getPlans } from "@/lib/plan-config";

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error("usage: npm run db:seed -- <admin-email>");
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const { data } = await clerk.users.getUserList({ emailAddress: [email] });
  const u = data[0];
  if (!u) throw new Error(`No Clerk user with email ${email}. Sign up first, then re-run.`);
  await clerk.users.updateUserMetadata(u.id, { publicMetadata: { role: "admin" } });
  await provisionUser({ id: u.id, email, name: [u.firstName, u.lastName].filter(Boolean).join(" "), avatarUrl: u.imageUrl });
  await db().update(users).set({ role: "admin" }).where(eq(users.id, u.id));
  console.log(`admin: ${email} (${u.id})`);
  console.log("plans:", Object.entries(await getPlans()).map(([k, v]) => `${k}=${v.monthlyCredits}cr`).join(", "));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
