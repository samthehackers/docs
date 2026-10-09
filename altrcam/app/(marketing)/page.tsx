import Link from "next/link";
import { Sparkles, Shirt, ImageIcon, Wand2, Zap, ShieldCheck } from "lucide-react";
import { AvailabilityNotice } from "@/components/availability-notice";
import { HowItWorksSteps } from "@/components/how-it-works-steps";
import { StudioCta } from "@/components/studio-cta";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getPlans } from "@/lib/plan-config";
import { savingSentence } from "@/lib/public-copy";
import { viewerId } from "@/lib/viewer";

export const metadata = { title: { absolute: "AltrCam — Be anyone. Live." } };

// Shows admin-edited plan limits: re-render at most once a minute instead of freezing the build-time values.
export const revalidate = 60;

const features = [
  { icon: Sparkles, title: "Become anyone", body: "Describe a character, or add a reference image. The AI restyles your live video to match. Results vary." },
  { icon: ImageIcon, title: "Swap your world", body: "Describe a different setting, like a beach or a boardroom, and the AI tries to put you there." },
  { icon: Shirt, title: "Change your fit", body: "Describe an outfit or a whole new style, and the AI tries to dress you in it." },
  { icon: Wand2, title: "Anime to oil paint", body: "Pick a built-in style preset, or write your own prompt." },
];

export default async function Landing() {
  const [plans, userId] = await Promise.all([getPlans(), viewerId()]);
  const signedIn = userId !== null;
  return (
    <>
      <section className="relative overflow-hidden">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-[480px] bg-[radial-gradient(60%_60%_at_50%_0%,hsl(var(--primary)/0.25),transparent)]" />
        <div className="relative mx-auto max-w-4xl px-4 py-24 text-center sm:py-32">
          <h1 className="text-5xl font-bold tracking-tight sm:text-7xl">
            Be anyone. <span className="gradient-text">Live.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
            AltrCam uses a realtime AI model to restyle your webcam video as you describe it: a character, a backdrop, an outfit or an art style. Write a prompt, press Go live, and watch the result in the studio.
          </p>
          <div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <StudioCta signedIn={signedIn} />
            <Link href="/pricing" className={buttonClass({ variant: "outline", size: "lg" })}>See pricing</Link>
          </div>
          {!signedIn && <p className="mt-4 text-sm text-muted-foreground">{plans.FREE.monthlyCredits} free credits every month. No card needed.</p>}
          <AvailabilityNotice className="mt-8" />
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

      <section id="how-it-works" className="mx-auto max-w-4xl px-4 pb-20">
        <h2 className="text-center text-3xl font-bold">How it works</h2>
        <div className="mt-8"><HowItWorksSteps headingLevel={3} /></div>
        <p className="mt-6 text-center text-sm text-muted-foreground">
          <Link href="/how-it-works" className="text-primary underline">Read the full explanation</Link> · <Link href="/privacy" className="text-primary underline">Privacy</Link>
        </p>
      </section>

      <section className="mx-auto max-w-4xl px-4 pb-24">
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            { icon: Zap, t: "1 credit = 1 second", b: "Counted from when you press Go live until the session ends. Monthly credits refill each cycle; bought top-ups never expire." },
            { icon: ShieldCheck, t: "Your camera, your call", b: "Your preview stays in your browser. Video goes to a third-party AI service only after you press Go live. Video only: no audio." },
            { icon: Sparkles, t: "Keep what you make", b: savingSentence(plans) },
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
          <StudioCta signedIn={signedIn} signedOutLabel="Sign up to open the studio" className="mt-6" />
        </div>
      </section>
    </>
  );
}
