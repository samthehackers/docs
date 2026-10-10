import { unstable_rethrow } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { supabaseConfigured } from "@/lib/config";

/**
 * The signed-in user's id, or null. Public pages use this to pick links (studio vs sign-up). It never calls Supabase when
 * Auth isn't configured, so those pages still render on a deployment with no credentials, and an Auth error reads as signed out.
 */
export async function viewerId(): Promise<string | null> {
  if (!supabaseConfigured()) return null;
  try {
    const { data: { user } } = await (await createClient()).auth.getUser();
    return user?.id ?? null;
  } catch (e) {
    unstable_rethrow(e); // Next's own signals (static-to-dynamic bailout, redirects) must pass through, or the route is rendered wrongly
    console.error("[viewer] could not read the session:", e instanceof Error ? e.message : e);
    return null;
  }
}
