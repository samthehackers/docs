import { SignIn } from "@clerk/nextjs";
import { AuthFrame } from "@/components/auth-frame";
import { SignupClosedNotice } from "@/components/signup-closed";
import { signInOpen } from "@/lib/config";

export const metadata = { title: "Sign in" };

export default function Page() {
  return (
    <AuthFrame heading="Sign in">
      {signInOpen() ? <SignIn /> : <SignupClosedNotice className="max-w-sm" />}
    </AuthFrame>
  );
}
