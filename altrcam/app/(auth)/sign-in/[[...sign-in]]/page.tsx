import { SignIn } from "@clerk/nextjs";
import { Logo } from "@/components/logo";
import { accountsOpen } from "@/lib/config";

export const metadata = { title: "Sign in" };

export default function Page() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <Logo />
      <p className="gradient-text text-xl font-semibold">Be anyone. Live.</p>
      {accountsOpen() ? <SignIn /> : <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">Accounts aren't available on this deployment yet. Please check back soon.</p>}
    </main>
  );
}
