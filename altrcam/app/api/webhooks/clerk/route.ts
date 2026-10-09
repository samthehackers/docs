import { NextResponse } from "next/server";
import { Webhook } from "svix";
import { db } from "@/lib/db";
import { provisionUser, syncProfile, deleteAccount } from "@/lib/users";

export const runtime = "nodejs";

interface ClerkUser {
  id: string; first_name?: string | null; last_name?: string | null; username?: string | null; image_url?: string;
  primary_email_address_id?: string; email_addresses?: { id: string; email_address: string }[];
}

const profile = (u: ClerkUser) => ({
  id: u.id,
  email: u.email_addresses?.find((e) => e.id === u.primary_email_address_id)?.email_address ?? u.email_addresses?.[0]?.email_address ?? "",
  name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "",
  avatarUrl: u.image_url,
});

/**
 * Clerk → svix → here. The signature (svix-id + svix-timestamp + raw body, signed with CLERK_WEBHOOK_SECRET) is verified before
 * anything is read; svix also rejects timestamps more than 5 minutes off, and refuses an empty secret, so an unset secret is a 401
 * for everything. user.created provisions the account and records the delivery as `clerk:<svix-id>` in webhook_events in the same
 * transaction, so a replay is a no-op (lib/users.ts provisionUser). If the webhook is late or never arrives, the first signed-in
 * page creates the row instead (ensureUserRow); either way the sign-up credits are granted once.
 */
export async function POST(req: Request) {
  const body = await req.text(); // raw body for signature verification
  const svixId = req.headers.get("svix-id") ?? "";
  let evt: { type: string; data: ClerkUser };
  try {
    evt = new Webhook(process.env.CLERK_WEBHOOK_SECRET ?? "").verify(body, {
      "svix-id": svixId,
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    }) as typeof evt;
  } catch {
    return new NextResponse("invalid signature", { status: 401 });
  }
  try {
    if (evt.type === "user.created") await provisionUser(profile(evt.data), db(), { provider: "clerk", eventId: `clerk:${svixId}`, type: evt.type });
    else if (evt.type === "user.updated") await syncProfile(profile(evt.data));
    else if (evt.type === "user.deleted") await deleteAccount(evt.data.id, { deleteClerk: false });
  } catch (e) {
    console.error("[clerk webhook]", e);
    return new NextResponse("error", { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
