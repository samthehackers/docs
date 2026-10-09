import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, parseBody, requireAdminId } from "@/lib/api";
import { db } from "@/lib/db";
import { DEFAULT_PLANS } from "@/lib/plans";
import { getPlans, PlanInput, resetPlanConfig, setPlanConfig } from "@/lib/plan-config";

const PlanName = z.enum(["FREE", "PRO", "LIFETIME"]);

export const GET = handle(async () => {
  await requireAdminId();
  return NextResponse.json({ effective: await getPlans(db()), defaults: DEFAULT_PLANS });
});

/** Replace one plan's limits. Admin only; validated and audited. */
export const PUT = handle(async (req: Request) => {
  const adminId = await requireAdminId();
  const b = await parseBody(req, z.object({ plan: PlanName, limits: PlanInput }));
  return NextResponse.json({ plan: await setPlanConfig(db(), b.plan, b.limits, adminId) });
});

/** Remove the override so the plan returns to the defaults in code. */
export const DELETE = handle(async (req: Request) => {
  const adminId = await requireAdminId();
  const b = await parseBody(req, z.object({ plan: PlanName }));
  return NextResponse.json({ plan: await resetPlanConfig(db(), b.plan, adminId) });
});
