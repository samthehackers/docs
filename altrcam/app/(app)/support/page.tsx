import { desc, eq } from "drizzle-orm";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TicketForm } from "@/components/ticket-form";
import { requireAppUser } from "@/lib/session-user";
import { db } from "@/lib/db";
import { supportTickets } from "@/db/schema";
import { relativeTime } from "@/lib/utils";

export const metadata = { title: "Support" };
export const dynamic = "force-dynamic";

export default async function Support() {
  const user = await requireAppUser();
  const tickets = await db().select().from(supportTickets).where(eq(supportTickets.userId, user.id)).orderBy(desc(supportTickets.createdAt));
  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div className="space-y-4"><h1 className="text-3xl font-bold">Support</h1><Card><TicketForm /></Card></div>
      <div className="space-y-4">
        <h2 className="text-xl font-semibold lg:mt-12">Your tickets</h2>
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
  );
}
