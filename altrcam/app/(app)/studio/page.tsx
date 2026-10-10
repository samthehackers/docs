import Link from "next/link";
import { and, eq, desc } from "drizzle-orm";
import { Studio } from "@/components/studio/studio";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { ledgerBalance } from "@/lib/credits";
import { presets, transformations } from "@/db/schema";
import { getPlans } from "@/lib/plan-config";
import { BUILTIN_PRESETS, type PresetKind } from "@/lib/studio-presets";
import { capabilities } from "@/lib/config";
import { STUDIO_NOTICES } from "@/lib/studio-messages";

export const metadata = { title: "Studio" };
export const dynamic = "force-dynamic";

export default async function StudioPage({ searchParams }: { searchParams: Promise<{ reuse?: string; preset?: string }> }) {
  const user = await requireAppUser();
  const sp = await searchParams;
  const plans = await getPlans();
  const [bal, mine] = await Promise.all([
    ledgerBalance(db(), user.id),
    db().select().from(presets).where(eq(presets.userId, user.id)).orderBy(desc(presets.createdAt)),
  ]);

  // Access gate: signed in → user row → credits > 0 → plan limits → render.
  if (bal.total <= 0) {
    return (
      <Card className="mx-auto max-w-lg py-12 text-center">
        <h1 className="text-2xl font-bold">You're out of credits</h1>
        <p className="mt-2 text-muted-foreground">Upgrade to Pro for {plans.PRO.monthlyCredits.toLocaleString()} credits a month, or grab a top-up pack. Free credits refill on the 1st.</p>
        <Link href="/billing" className={buttonClass({ variant: "gradient", size: "lg", className: "mt-6" })}>See options</Link>
      </Card>
    );
  }

  let initial = { prompt: BUILTIN_PRESETS[0].prompt, enablePromptExpansion: true, kind: BUILTIN_PRESETS[0].kind as PresetKind, referencePath: null as string | null };
  if (sp.reuse) {
    const id = Number(sp.reuse);
    if (Number.isInteger(id)) {
      const [t] = await db().select().from(transformations).where(and(eq(transformations.id, id), eq(transformations.userId, user.id)));
      if (t) {
        const s = (t.settings ?? {}) as { expand?: boolean; kind?: PresetKind; referencePath?: string | null };
        initial = { prompt: t.prompt, enablePromptExpansion: s.expand ?? true, kind: s.kind ?? "prompt", referencePath: s.referencePath?.startsWith(`${user.id}/`) ? s.referencePath : null };
      }
    }
  } else if (sp.preset) {
    const m = mine.find((x) => x.id === Number(sp.preset));
    if (m) initial = { prompt: m.prompt, enablePromptExpansion: true, kind: m.kind as PresetKind, referencePath: m.imagePath };
  }

  const plan = plans[user.plan];
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-bold">Studio</h1>
      {!capabilities().liveTransformation && <p role="status" data-testid="studio-not-configured" className="rounded-lg border border-accent/50 bg-accent/10 p-3 text-sm">{STUDIO_NOTICES.notConfigured}</p>}
      <Studio
        resolution={plan.maxResolution}
        clipRecording={plan.clipRecording}
        balance={bal.total}
        presets={mine.map((m) => ({ id: m.id, name: m.name, kind: m.kind as PresetKind, prompt: m.prompt, imagePath: m.imagePath }))}
        initial={initial}
      />
    </div>
  );
}
