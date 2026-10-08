import Link from "next/link";
import { Camera, Wand2, Radio, Coins } from "lucide-react";
import { buttonClass } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export const metadata = { title: "How it works" };

const steps = [
  { icon: Camera, t: "1. Allow your camera", b: "Open the studio and grant camera access. Nothing is streamed until you press Go live." },
  { icon: Wand2, t: "2. Pick a look", b: "Choose a preset or write a prompt. Optionally add a reference image for a character, outfit or backdrop." },
  { icon: Radio, t: "3. Go live", b: "AltrCam connects your camera to a realtime AI model and shows the transformed video back to you instantly." },
  { icon: Coins, t: "4. Pay by the second", b: "1 credit = 1 second of live video. Credits are only spent while a session is running." },
];

export default function HowItWorks() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <h1 className="text-center text-4xl font-bold">How <span className="gradient-text">AltrCam</span> works</h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">From webcam to someone else in four steps.</p>
      <div className="mt-12 grid gap-4 sm:grid-cols-2">
        {steps.map(({ icon: Icon, t, b }) => (
          <Card key={t}>
            <Icon className="h-6 w-6 text-primary" aria-hidden />
            <h2 className="mt-4 font-semibold">{t}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{b}</p>
          </Card>
        ))}
      </div>
      <div className="mt-12 text-center">
        <Link href="/sign-up" className={buttonClass({ variant: "gradient", size: "lg" })}>Try it free</Link>
      </div>
    </div>
  );
}
