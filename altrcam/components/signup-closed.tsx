import Link from "next/link";
import { cn } from "@/lib/utils";
import { SIGNUP_CLOSED, SIGNUP_CLOSED_LINK } from "@/lib/public-copy";

/** "Sign-up isn't open yet. Email us to hear when it opens": the one closed-state notice, wherever a sign-up button would be. */
export function SignupClosedNotice({ className }: { className?: string }) {
  return (
    <p role="status" className={cn("text-center text-sm text-muted-foreground", className)}>
      {SIGNUP_CLOSED}{" "}
      <Link href={SIGNUP_CLOSED_LINK.href} className="text-primary underline underline-offset-2">{SIGNUP_CLOSED_LINK.label}</Link>
    </p>
  );
}
