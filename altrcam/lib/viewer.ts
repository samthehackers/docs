import { unstable_rethrow } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
export async function viewerId(): Promise<string | null> {
  try { const { data: { user } } = await (await createClient()).auth.getUser(); return user?.id ?? null; }
  catch (e) { unstable_rethrow(e); console.error("[viewer] could not read the session:", e instanceof Error ? e.message : e); return null; }
}
