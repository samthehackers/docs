import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Card, CardTitle } from "@/components/ui/card";
import { CopyLink } from "@/components/copy-link";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { referralStats } from "@/lib/referrals";
import { REFERRAL } from "@/lib/plans";
import { fmtNum } from "@/lib/utils";

export const metadata = { title: "Referrals" };
export const dynamic = "force-dynamic";

export default async function Referrals() {
  const user = await requireAppUser();
  let code = user.referralCode;
  if (!code) { // accounts created before referrals existed
    code = randomBytes(4).toString("hex");
    await db().update(users).set({ referralCode: code }).where(eq(users.id, user.id));
  }
  const stats = await referralStats(db(), user.id);
  const link = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://altrcam.com"}/?ref=${code}`;
  const mins = Math.round(REFERRAL.rewardCredits / 60);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold">Invite friends</h1>
        <p className="mt-1 text-muted-foreground">Earn {fmtNum(REFERRAL.rewardCredits)} credits ({mins} minutes of live video) when a friend you invite upgrades to Pro or Lifetime.</p>
      </div>

      <Card className="space-y-3">
        <CardTitle>Your link</CardTitle>
        <CopyLink url={link} />
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardTitle>Friends joined</CardTitle><p className="mt-2 text-4xl font-bold">{fmtNum(stats.signedUp)}</p></Card>
        <Card><CardTitle>Rewarded</CardTitle><p className="mt-2 text-4xl font-bold">{fmtNum(stats.rewarded)}</p></Card>
        <Card><CardTitle>Credits earned</CardTitle><p className="mt-2 text-4xl font-bold">{fmtNum(stats.creditsEarned)}</p></Card>
      </div>

      <Card>
        <h2 className="mb-3 font-semibold">How it works</h2>
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          <li>Your friend opens your link and signs up within {REFERRAL.cookieDays} days of clicking it.</li>
          <li>When they make their first Pro or Lifetime payment, the credits land in your account. They never expire.</li>
          <li>Top-up packs don't count. Each friend can only be rewarded once.</li>
          <li>You can earn rewards for up to {REFERRAL.maxRewardsPerReferrer} friends ({stats.remainingRewards} left).</li>
          <li>Referring yourself or your own other accounts isn't allowed.</li>
        </ul>
      </Card>
    </div>
  );
}
