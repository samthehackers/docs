import { SignUp } from "@clerk/nextjs";
import { AuthFrame, SignUpAgreement } from "@/components/auth-frame";
import { SignupClosedNotice } from "@/components/signup-closed";
import { accountsOpen } from "@/lib/config";

export const metadata = { title: "Sign up" };

export default function Page() {
  return (
    <AuthFrame heading="Create your account">
      {accountsOpen() ? (
        <>
          <SignUp />
          <SignUpAgreement />
        </>
      ) : <SignupClosedNotice className="max-w-sm" />}
    </AuthFrame>
  );
}
