import { redirect, unstable_rethrow } from "next/navigation";
import { Logo } from "@/components/logo";
import { VerifyEmail } from "@/components/verify-email";
import { supabaseConfigured } from "@/lib/config";
import { createClient } from "@/lib/supabase/server";

export const metadata = { title: "Confirm your email" };
export const dynamic = "force-dynamic";

export default async function Page({ searchParams }: { searchParams: Promise<{ email?: string | string[] }> }) {
  const q = (await searchParams).email;
  let email = typeof q === "string" ? q.slice(0, 320) : "";
  let signedIn = false;
  if (supabaseConfigured()) {
    try {
      const { data: { user } } = await (await createClient()).auth.getUser();
      if (user?.email_confirmed_at) redirect("/dashboard");
      if (user) { signedIn = true; email = user.email ?? email; }
    } catch (e) { unstable_rethrow(e); }
  }
  return <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10"><Logo /><p className="gradient-text text-xl font-semibold">Be anyone. Live.</p><VerifyEmail initialEmail={email} signedIn={signedIn} /></main>;
}
