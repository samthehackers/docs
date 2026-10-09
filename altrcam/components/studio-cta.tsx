import Link from "next/link";
import { buttonClass } from "@/components/ui/button";

/**
 * The main call to action. Signed-in visitors go straight to the studio; everyone else is asked to sign up first. When accounts
 * are not open (accountsOpen() in lib/config.ts) a signed-out visitor gets no button at all: the page says sign-up isn't open.
 */
export function StudioCta({ signedIn, accountsOpen = true, signedOutLabel = "Try it free", size = "lg", className }: {
  signedIn: boolean; accountsOpen?: boolean; signedOutLabel?: string; size?: "default" | "sm" | "lg"; className?: string;
}) {
  if (!signedIn && !accountsOpen) return null;
  return (
    <Link href={signedIn ? "/studio" : "/sign-up"} className={buttonClass({ variant: "gradient", size, className })}>
      {signedIn ? "Open the studio" : signedOutLabel}
    </Link>
  );
}
