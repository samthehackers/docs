import Link from "next/link";
import { Logo } from "@/components/logo";

/**
 * The frame around Clerk's sign-in and sign-up forms (and their closed state). The h1 is visually hidden: Clerk's card has its
 * own visible title, and when the form isn't shown the page still needs a heading.
 */
export function AuthFrame({ heading, children }: { heading: string; children: React.ReactNode }) {
  const link = "underline-offset-4 hover:text-foreground hover:underline";
  return (
    <main id="content" className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-10">
      <h1 className="sr-only">{heading}</h1>
      <Logo />
      <p className="gradient-text text-xl font-semibold">Be anyone. Live.</p>
      {children}
      <p className="flex gap-4 text-sm text-muted-foreground">
        <Link href="/" className={link}>Back to home</Link>
        <Link href="/privacy" className={link}>Privacy</Link>
      </p>
    </main>
  );
}

/** Under the sign-up form: what creating an account means. The acceptable-use rules are section 2 of the Terms for now. */
export function SignUpAgreement() {
  const link = "text-primary underline underline-offset-2";
  return (
    <p className="max-w-sm text-center text-xs text-muted-foreground">
      By creating an account you agree to the <Link href="/terms" className={link}>Terms</Link> and{" "}
      <Link href="/terms#acceptable-use" className={link}>Acceptable Use Policy</Link>.
    </p>
  );
}
