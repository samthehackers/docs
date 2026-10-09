import { SignUp } from "@clerk/nextjs";
import { AuthFrame, SignUpAgreement } from "@/components/auth-frame";
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
      ) : <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">Accounts aren't available on this deployment yet. Please check back soon.</p>}
    </AuthFrame>
  );
}
