import { SignIn } from "@clerk/nextjs";
import { AuthFrame } from "@/components/auth-frame";
import { signInOpen } from "@/lib/config";

export const metadata = { title: "Sign in" };

export default function Page() {
  return (
    <AuthFrame heading="Sign in">
      {signInOpen() ? <SignIn /> : <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">Accounts aren't available on this deployment yet. Please check back soon.</p>}
    </AuthFrame>
  );
}
