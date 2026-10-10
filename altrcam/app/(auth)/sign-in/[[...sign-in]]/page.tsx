import { Logo } from "@/components/logo";
import { AuthForm } from "@/components/auth-form";
import { accountsOpen, googleAuthEnabled } from "@/lib/config";
import { authErrorMessage } from "@/lib/safe-redirect";

export const metadata = { title: "Sign in" };

export default async function Page({ searchParams }: { searchParams?: Promise<{ error?: string | string[] }> }) {
  const error = authErrorMessage((await searchParams)?.error);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <Logo />
      <p className="gradient-text text-xl font-semibold">Be anyone. Live.</p>
      {error && <p role="alert" className="max-w-sm text-center text-sm text-destructive">{error}</p>}
      {accountsOpen() ? <AuthForm mode="sign-in" google={googleAuthEnabled()} /> : <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">Account access is not configured for this deployment yet. Add the Supabase and database configuration to enable sign-in.</p>}
    </main>
  );
}
