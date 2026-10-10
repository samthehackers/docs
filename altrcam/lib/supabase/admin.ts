import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client with the secret (service-role) key. Bypasses RLS and can manage Auth users, so it must
 * never be imported from a client component. The Vercel Supabase integration sets both key names; either works.
 */
export function supabaseAdminConfig(env: Record<string, string | undefined> = process.env) {
  const url = env.SUPABASE_URL?.trim() || env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SECRET_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  return url && key ? { url, key } : null;
}

export function createAdminClient(): SupabaseClient {
  const cfg = supabaseAdminConfig();
  if (!cfg) throw new Error("Supabase admin client not configured: set SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
  return createClient(cfg.url, cfg.key, { auth: { persistSession: false, autoRefreshToken: false } });
}
