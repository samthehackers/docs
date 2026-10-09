import Link from "next/link";
import { Sparkles, Shirt, ImageIcon, Wand2, Zap, ShieldCheck } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPlan } from "@/lib/plan-config";

export const metadata = { title: { absolute: "AltrCam — Be anyone. Live." } };

// Shows admin-edited plan limits: re-render at most once a minute instead of freezing the build-time values.
export const revalidate = 60;

const features = [
  { icon: Sparkles, title: "Become anyone", body: "Describe a character. Your face, their look, live on camera." },
  { icon: ImageIcon, title: "Swap your world", body: "Beach, boardroom, spaceship. Change the background with a sentence." },
  { icon: Shirt, title: "Change your fit", body: "Try a new outfit or a whole new style without leaving your chair." },
  { icon: Wand2, title: "Anime to oil paint", body: "One tap style presets, or write your own prompt." },
];

export default async function Landing() {
  const free = await getPlan("FREE");
  return (
    <>
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_60%_at_50%_0%,hsl(var(--primary)/0.25),transparent)]" />
        <div className="relative mx-auto max-w-4xl px-4 py-24 text-center sm:py-32">
          <h1 className="text-5xl font-bold tracking-tight sm:text-7xl">
            Be anyone. <span className="gradient-text">Live.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
            AltrCam turns your webcam into anyone, anywhere, in realtime. No editing. No waiting. Just press go.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Link href="/sign-up" className={buttonClass({ variant: "gradient", size: "lg" })}>Try it free</Link>
            <Link href="/pricing" className={buttonClass({ variant: "outline", size: "lg" })}>See pricing</Link>
          </div>
          <p className="mt-4 text-sm text-muted-foreground">{free.monthlyCredits} free credits every month. No card needed.</p>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-4 pb-20 sm:grid-cols-2 lg:grid-cols-4">
        {features.map(({ icon: Icon, title, body }) => (
          <Card key={title}>
            <Icon className="h-6 w-6 text-primary" aria-hidden />
            <h2 className="mt-4 font-semibold">{title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{body}</p>
          </Card>
        ))}
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-24">
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            { icon: Zap, t: "1 credit = 1 second", b: "Simple, honest metering. You only pay while the magic is on." },
            { icon: ShieldCheck, t: "Your camera, your call", b: "Video streams only while a session is live. Stop anytime." },
            { icon: Sparkles, t: "Made to share", b: "Snapshot or record a clip on Pro and post it anywhere." },
          ].map(({ icon: Icon, t, b }) => (
            <div key={t}>
              <Icon className="h-5 w-5 text-accent" aria-hidden />
              <h3 className="mt-3 font-semibold">{t}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{b}</p>
            </div>
          ))}
        </div>
        <div className="mt-16 rounded-2xl border bg-card p-10 text-center glow">
          <h2 className="text-3xl font-bold">Ready to go live as someone else?</h2>
          <Link href="/sign-up" className={buttonClass({ variant: "gradient", size: "lg", className: "mt-6" })}>Open the studio</Link>
        </div>
      </section>
    </>
  );
}
