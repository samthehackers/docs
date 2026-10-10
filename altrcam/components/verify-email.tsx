"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

/** "Check your inbox" with a resend button. Used after sign-up and when an unconfirmed account tries to sign in. */
export function VerifyEmail({ initialEmail, signedIn }: { initialEmail: string; signedIn: boolean }) {
  const [email, setEmail] = useState(initialEmail);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function resend(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const { error } = await createClient().auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });
    setBusy(false);
    setMessage(error
      ? (/rate|seconds|too many/i.test(error.message) ? "Please wait a minute before asking for another email." : "We could not send the email. Please try again.")
      : "Sent. Check your inbox (and spam folder) for the confirmation link.");
  }
  async function signOut() { await createClient().auth.signOut(); window.location.assign("/sign-in"); }
  return <form onSubmit={resend} className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-white/10 bg-white/[.04] p-6">
    <h1 className="text-lg font-semibold">Confirm your email</h1>
    <p className="text-sm text-muted-foreground">We sent a confirmation link to your email address. Open it in this browser to finish setting up your account.</p>
    <label className="flex flex-col gap-2 text-sm">Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="rounded-lg border border-white/10 bg-black/20 px-3 py-2" /></label>
    {message && <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{message}</p>}
    <button disabled={busy} className="rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50">{busy ? "Please wait…" : "Resend confirmation email"}</button>
    {signedIn
      ? <button type="button" onClick={signOut} className="text-center text-sm text-muted-foreground underline">Use a different account</button>
      : <Link className="text-center text-sm text-muted-foreground underline" href="/sign-in">Back to sign in</Link>}
  </form>;
}
