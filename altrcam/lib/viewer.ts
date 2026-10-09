import { auth } from "@clerk/nextjs/server";
import { clerkConfigured } from "@/lib/config";

/**
 * The signed-in user's id, or null. Public pages use this to pick links (studio vs sign-up). It never calls Clerk when
 * Clerk isn't configured, so those pages still render on a deployment with no credentials.
 */
export async function viewerId(): Promise<string | null> {
  if (!clerkConfigured()) return null;
  return (await auth()).userId ?? null;
}
