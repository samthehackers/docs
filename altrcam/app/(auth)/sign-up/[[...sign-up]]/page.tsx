import { SignUp } from "@clerk/nextjs";
import { Logo } from "@/components/logo";
import { accountsOpen } from "@/lib/config";

export const metadata = { title: "Sign up" };

export default function Page() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <Logo />
      <p className="gradient-text text-xl font-semibold">Be anyone. Live.</p>
      {accountsOpen() ? <SignUp /> : <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">Account access is not configured for this deployment yet. Add the Clerk and database configuration to enable registration.</p>}
    </main>
  );
}
