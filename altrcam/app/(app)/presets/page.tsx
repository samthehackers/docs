import { desc, eq } from "drizzle-orm";
import { PresetsManager } from "@/components/presets-manager";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { presets } from "@/db/schema";
import { PLANS } from "@/lib/plans";

export const metadata = { title: "Presets" };
export const dynamic = "force-dynamic";

export default async function Presets() {
  const user = await requireAppUser();
  const rows = await db().select().from(presets).where(eq(presets.userId, user.id)).orderBy(desc(presets.createdAt));
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Presets</h1>
      <PresetsManager cap={PLANS[user.plan].presets} presets={rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind, prompt: r.prompt, hasImage: !!r.imagePath }))} />
    </div>
  );
}
