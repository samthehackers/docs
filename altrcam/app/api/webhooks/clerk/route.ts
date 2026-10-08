import { NextResponse } from "next/server";
import { Webhook } from "svix";
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

export async function POST(req: Request) {
  const body = await req.text(); // raw body for signature verification
  let evt: { type: string; data: ClerkUser };
  try {
    evt = new Webhook(process.env.CLERK_WEBHOOK_SECRET ?? "").verify(body, {
      "svix-id": req.headers.get("svix-id") ?? "",
      "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
      "svix-signature": req.headers.get("svix-signature") ?? "",
    }) as typeof evt;
  } catch {
    return new NextResponse("invalid signature", { status: 401 });
  }
  try {
    if (evt.type === "user.created") await provisionUser(profile(evt.data));
    else if (evt.type === "user.updated") await syncProfile(profile(evt.data));
    else if (evt.type === "user.deleted") await deleteAccount(evt.data.id, { deleteClerk: false });
  } catch (e) {
    console.error("[clerk webhook]", e);
    return new NextResponse("error", { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
