import { z } from "zod";
import { eq } from "drizzle-orm";
import { auditLog, planConfig } from "@/db/schema";
import { db, type DB } from "@/lib/db";
import { DEFAULT_PLANS, type Plan, type PlanConfig } from "@/lib/plans";

/** Bounds enforced here and by a CHECK constraint on the table. */
export const PlanInput = z.object({
  monthlyCredits: z.number().int().min(0).max(1_000_000),
  maxSessionSeconds: z.number().int().min(10).max(14_400),
  maxResolution: z.enum(["low", "high"]),
  presets: z.number().int().min(0).max(1000),
  historyDays: z.number().int().min(1).max(3650).nullable(), // null = keep forever
  clipRecording: z.boolean(),
});
export type PlanInputT = z.infer<typeof PlanInput>;

type Plans = Record<Plan, PlanConfig>;
const TTL_MS = 15_000;
let cache: { at: number; value: Plans } | null = null;
export const invalidatePlanCache = () => { cache = null; };

const clone = (p: Plans): Plans => ({ FREE: { ...p.FREE }, PRO: { ...p.PRO }, LIFETIME: { ...p.LIFETIME } });

/**
 * Effective plan limits: admin overrides from the database merged over the defaults in lib/plans.ts.
 * Falls back to the defaults (never throws) if the database is unconfigured or unreachable, so public
 * pages keep rendering. Cached for a few seconds per instance when using the default connection.
 */
export async function getPlans(d?: DB): Promise<Plans> {
  if (!d && cache && Date.now() - cache.at < TTL_MS) return clone(cache.value);
  if (!d && !process.env.DATABASE_URL) return clone(DEFAULT_PLANS);

  const merged = clone(DEFAULT_PLANS);
  try {
    for (const r of await (d ?? db()).select().from(planConfig)) {
      merged[r.plan] = {
        ...merged[r.plan],
        monthlyCredits: r.monthlyCredits, maxSessionSeconds: r.maxSessionSeconds,
        maxResolution: r.maxResolution === "high" ? "high" : "low",
        presets: r.presets, historyDays: r.historyDays, clipRecording: r.clipRecording,
      };
    }
  } catch (e) {
    console.error("[plans] could not read overrides, using defaults:", e instanceof Error ? e.message : e);
    return clone(DEFAULT_PLANS);
  }
  if (!d) cache = { at: Date.now(), value: merged };
  return clone(merged);
}

export async function getPlan(plan: Plan, d?: DB): Promise<PlanConfig> {
  return (await getPlans(d))[plan];
}

/** Replace a plan's limits. Audited with before/after. */
export async function setPlanConfig(d: DB, plan: Plan, input: unknown, actorId: string) {
  const next = PlanInput.parse(input);
  const before = (await getPlans(d))[plan];
  await d.transaction(async (tx) => {
    await tx.insert(planConfig).values({ plan, ...next, updatedBy: actorId })
      .onConflictDoUpdate({ target: planConfig.plan, set: { ...next, updatedBy: actorId, updatedAt: new Date() } });
    await tx.insert(auditLog).values({ actorId, action: "plan_config.update", target: plan, meta: { before: pick(before), after: next } });
  });
  invalidatePlanCache();
  return getPlan(plan, d);
}

/** Drop the override so the plan goes back to the defaults in code. */
export async function resetPlanConfig(d: DB, plan: Plan, actorId: string) {
  const before = (await getPlans(d))[plan];
  await d.transaction(async (tx) => {
    await tx.delete(planConfig).where(eq(planConfig.plan, plan));
    await tx.insert(auditLog).values({ actorId, action: "plan_config.reset", target: plan, meta: { before: pick(before) } });
  });
  invalidatePlanCache();
  return getPlan(plan, d);
}

const pick = (p: PlanConfig): PlanInputT => ({
  monthlyCredits: p.monthlyCredits, maxSessionSeconds: p.maxSessionSeconds, maxResolution: p.maxResolution,
  presets: p.presets, historyDays: p.historyDays, clipRecording: p.clipRecording,
});
