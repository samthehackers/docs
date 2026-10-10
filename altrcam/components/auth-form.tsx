"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const supabase = createClient();
    const result = mode === "sign-in"
      ? await supabase.auth.signInWithPassword({ email, password })
      : await supabase.auth.signUp({ email, password, options: { emailRedirectTo: process.env.NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL ?? `${window.location.origin}/auth/callback` } });
    setBusy(false);
    if (result.error) { setMessage(result.error.message.includes("Invalid") ? "Invalid email or password." : result.error.message); return; }
    if (mode === "sign-up" && !result.data.session) { setMessage("Check your email to confirm your account before signing in."); return; }
    router.push("/dashboard"); router.refresh();
  }
  async function google() {
    const supabase = createClient();
    await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: `${window.location.origin}/auth/callback` } });
  }
  return <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-white/10 bg-white/[.04] p-6">
    <label className="flex flex-col gap-2 text-sm">Email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2" /></label>
    <label className="flex flex-col gap-2 text-sm">Password<input required minLength={8} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2" /></label>
    {message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
    <button disabled={busy} className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">{busy ? "Please wait…" : mode === "sign-in" ? "Sign in" : "Create account"}</button>
    <button type="button" onClick={google} className="rounded-lg border border-white/15 px-4 py-2">Continue with Google</button>
    <Link className="text-center text-sm text-muted-foreground underline" href={mode === "sign-in" ? "/sign-up" : "/sign-in"}>{mode === "sign-in" ? "Create an account" : "Already have an account? Sign in"}</Link>
  </form>;
}
