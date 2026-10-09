import { desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TicketForm } from "@/components/ticket-form";
import { Troubleshooting } from "@/components/troubleshooting";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { getPlans } from "@/lib/plan-config";
import { supportTickets } from "@/db/schema";
import { relativeTime } from "@/lib/utils";

export const metadata = { title: "Support" };
export const dynamic = "force-dynamic";

export default async function Support() {
  const user = await requireAppUser();
  const [tickets, plans] = await Promise.all([
    db().select().from(supportTickets).where(eq(supportTickets.userId, user.id)).orderBy(desc(supportTickets.createdAt)),
    getPlans(),
  ]);
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-bold">Support and troubleshooting</h1>
        <p className="mt-1 text-sm text-muted-foreground">Check the answers below first. If they don&apos;t solve it, <a href="#ticket" className="text-primary underline">send a ticket</a>.</p>
      </div>

      <Troubleshooting plans={plans} />

      <div id="ticket" className="grid scroll-mt-24 gap-8 lg:grid-cols-2">
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Send a ticket</h2>
          <Card>
            <TicketForm />
          </Card>
          <p className="text-xs text-muted-foreground">Helpful to include: what you were doing, the exact message you saw, your browser and device, and for a payment the reference, date and amount. Never include a password or card number.</p>
        </div>
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Your tickets</h2>
          {tickets.length === 0 ? <Card className="text-center text-sm text-muted-foreground">No tickets yet.</Card> : tickets.map((t) => (
            <Card key={t.id} className="space-y-2">
              <div className="flex items-center justify-between gap-2"><p className="font-medium">{t.subject}</p><Badge>{t.status}</Badge></div>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{t.body}</p>
              {t.adminReply && <div className="rounded-md border-l-2 border-primary bg-muted/40 p-3 text-sm"><p className="mb-1 text-xs font-semibold text-primary">AltrCam replied</p><p className="whitespace-pre-wrap">{t.adminReply}</p></div>}
              <p className="text-xs text-muted-foreground">{relativeTime(t.createdAt)}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
