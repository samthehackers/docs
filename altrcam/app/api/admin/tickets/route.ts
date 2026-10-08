import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { handle, HttpError, parseBody, requireAdminId } from "@/lib/api";
import { db } from "@/lib/db";
import { auditLog, supportTickets } from "@/db/schema";
import { notify, userEmailIfEnabled } from "@/lib/notifications";
import { esc, sendEmail } from "@/lib/email";

const Body = z.object({ id: z.number().int().positive(), reply: z.string().trim().min(1).max(4000), status: z.enum(["open", "answered", "closed"]).default("answered") });

export const POST = handle(async (req: Request) => {
  const adminId = await requireAdminId();
  const b = await parseBody(req, Body);
  const [t] = await db().update(supportTickets).set({ adminReply: b.reply, status: b.status, updatedAt: new Date() }).where(eq(supportTickets.id, b.id)).returning();
  if (!t) throw new HttpError(404, "Ticket not found");
  await db().insert(auditLog).values({ actorId: adminId, action: "ticket.reply", target: String(t.id) });
  await notify(db(), t.userId, "ticket_reply", "New reply to your ticket", t.subject);
  const to = await userEmailIfEnabled(db(), t.userId);
  if (to) await sendEmail(to, `Re: ${t.subject}`, `<p>${esc(b.reply).replace(/\n/g, "<br/>")}</p>`);
  return NextResponse.json({ ok: true });
});
