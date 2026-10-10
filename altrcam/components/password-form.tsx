"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Sets a new password for the signed-in user. Reached from the password-reset email (the link signs the user in with a
 * recovery session, then lands here) or from Settings.
 */
export function PasswordForm() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "busy" | "done" } | { kind: "error"; message: string }>({ kind: "idle" });
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (password.length < 8) { setState({ kind: "error", message: "Use at least 8 characters." }); return; }
    if (password !== confirm) { setState({ kind: "error", message: "The two passwords don't match." }); return; }
    setState({ kind: "busy" });
    const { error } = await createClient().auth.updateUser({ password });
    if (!error) { setPassword(""); setConfirm(""); setState({ kind: "done" }); return; }
    const message = error.code === "same_password" ? "Choose a password you haven't used for this account."
      : error.code === "weak_password" ? "That password is too weak. Try a longer one."
      : /session|jwt|auth/i.test(error.message) ? "Your reset link has expired. Request a new one from the sign-in page."
      : "We couldn't update your password. Please try again.";
    setState({ kind: "error", message });
  }
  if (state.kind === "done") {
    return <div className="space-y-3"><p role="status" className="text-sm">Your password has been updated.</p><Link href="/dashboard" className="text-sm underline underline-offset-4">Go to the dashboard</Link></div>;
  }
  return (
    <form onSubmit={submit} className="max-w-sm space-y-3">
      <label className="block text-sm">New password<Input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1" /></label>
      <label className="block text-sm">Confirm new password<Input required type="password" minLength={8} autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="mt-1" /></label>
      {state.kind === "error" && <p role="alert" className="text-sm text-destructive">{state.message}</p>}
      <Button type="submit" disabled={state.kind === "busy"}>{state.kind === "busy" ? "Saving…" : "Update password"}</Button>
    </form>
  );
}
