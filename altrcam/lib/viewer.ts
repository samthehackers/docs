import { auth } from "@clerk/nextjs/server";
import { clerkConfigured } from "@/lib/config";

/**
 * The signed-in user's id, or null. Public pages use this to pick links (studio vs sign-up). It never calls Clerk when
 * Clerk isn't configured, so those pages still render on a deployment with no credentials, and a Clerk error reads as signed out.
 */
export async function viewerId(): Promise<string | null> {
  if (!clerkConfigured()) return null;
  try {
    return (await auth()).userId ?? null;
  } catch (e) {
    // A public page must keep rendering if Clerk misbehaves; the visitor just sees the signed-out buttons.
    console.error("[viewer] could not read the session:", e instanceof Error ? e.message : e);
    return null;
  }
}
