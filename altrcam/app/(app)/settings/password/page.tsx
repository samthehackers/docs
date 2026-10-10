import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PasswordForm } from "@/components/password-form";
import { requireAppUser } from "@/lib/session-user";

export const metadata = { title: "Change password" };

/** Where the password-reset email lands (via /auth/callback or /auth/confirm), and where Settings links for a change. */
export default async function PasswordPage() {
  const user = await requireAppUser();
  return (
    <div className="space-y-8">
      <h1 className="text-3xl font-bold">Change password</h1>
      <Card>
        <p className="mb-4 text-sm text-muted-foreground">Signed in as <span className="font-medium text-foreground">{user.email}</span>.</p>
        <PasswordForm />
      </Card>
      <Link href="/settings" className="text-sm text-muted-foreground underline underline-offset-4">Back to settings</Link>
    </div>
  );
}
