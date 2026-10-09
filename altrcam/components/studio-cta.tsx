import Link from "next/link";
import { buttonClass } from "@/components/ui/button";

/** The main call to action. Signed-in visitors go straight to the studio; everyone else is asked to sign up first. */
export function StudioCta({ signedIn, signedOutLabel = "Try it free", size = "lg", className }: {
  signedIn: boolean; signedOutLabel?: string; size?: "default" | "sm" | "lg"; className?: string;
}) {
  return (
    <Link href={signedIn ? "/studio" : "/sign-up"} className={buttonClass({ variant: "gradient", size, className })}>
      {signedIn ? "Open the studio" : signedOutLabel}
    </Link>
  );
}
