import { SignIn } from "@clerk/nextjs";
import { Logo } from "@/components/logo";

export const metadata = { title: "Sign in" };

export default function Page() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <Logo />
      <p className="gradient-text text-xl font-semibold">Be anyone. Live.</p>
      <SignIn />
    </main>
  );
}
