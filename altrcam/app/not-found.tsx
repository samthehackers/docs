import Link from "next/link";
import { buttonClass } from "@/components/ui/button";

export const metadata = { title: "Page not found" };

const elsewhere = [
  { label: "Pricing", href: "/pricing" },
  { label: "How it works", href: "/how-it-works" },
  { label: "Contact", href: "/contact" },
];

export default function NotFound() {
  return (
    <main id="content" className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <h1 className="text-6xl font-bold gradient-text">404</h1>
      <p className="text-muted-foreground">That page doesn&apos;t exist.</p>
      <Link href="/" className={buttonClass({ variant: "gradient" })}>Back home</Link>
      <nav aria-label="Elsewhere on AltrCam" className="mt-2 flex gap-4 text-sm text-muted-foreground">
        {elsewhere.map((l) => <Link key={l.href} href={l.href} className="underline-offset-4 hover:text-foreground hover:underline">{l.label}</Link>)}
      </nav>
    </main>
  );
}
