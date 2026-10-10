import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { payments } from "@/db/schema";
import { PRODUCTS, type ProductId } from "@/lib/plans";
import { fmtDate } from "@/lib/account-summary";
import { money } from "@/lib/utils";
import { PrintButton } from "@/components/billing/print-button";

export const metadata = { title: "Receipt" };
export const dynamic = "force-dynamic";

/**
 * A printable receipt for one of the signed-in person's own successful payments. Scoped by owner in the query itself: another
 * account's reference (or an unpaid one) is a 404, never a different person's receipt.
 */
export default async function Receipt({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const user = await requireAppUser();
  if (!reference || reference.length > 100) notFound();
  const [p] = await db().select().from(payments).where(and(eq(payments.reference, reference), eq(payments.userId, user.id), eq(payments.status, "success")));
  if (!p) notFound();
  const item = PRODUCTS[p.product as ProductId]?.label ?? p.product;
  const rows: [string, string][] = [
    ["Date", fmtDate(p.createdAt)],
    ["Item", item],
    ["Amount paid", `${money(p.amountMinor, p.currency)} (${p.currency})`],
    ["Paid with", p.provider === "paystack" ? "Card or other method through Paystack" : "Cryptocurrency through NOWPayments"],
    ["Reference", p.reference],
    ["Billed to", user.name ? `${user.name} (${user.email})` : user.email],
  ];
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href="/billing" className="text-sm text-primary underline">Back to Billing</Link>
        <PrintButton />
      </div>
      <article className="rounded-lg border bg-card p-6">
        <h1 className="text-2xl font-bold">AltrCam receipt</h1>
        <p className="mt-1 text-sm text-muted-foreground">A record of a payment you made. It is not a tax invoice.</p>
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="break-all font-medium">{v}</dd>
            </div>
          ))}
        </dl>
      </article>
    </div>
  );
}
