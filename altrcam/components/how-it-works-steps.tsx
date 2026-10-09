import { Camera, Wand2, Radio, Coins } from "lucide-react";
import { Card } from "@/components/ui/card";

/** The four steps, shared by the landing page and /how-it-works so they cannot drift apart. */
export const HOW_IT_WORKS_STEPS = [
  { icon: Camera, t: "1. Allow your camera", b: "Sign in, open the studio and allow camera access. You see a preview that stays in your browser until you press Go live. AltrCam uses video only, never your microphone." },
  { icon: Wand2, t: "2. Pick a look", b: "Choose a preset or write a prompt describing a character, backdrop, outfit or style. Optionally add a reference image to steer the result." },
  { icon: Radio, t: "3. Go live", b: "Your camera video is sent to a third-party realtime AI model, and the transformed video is shown back to you in the studio. Results vary." },
  { icon: Coins, t: "4. Pay by the second", b: "1 credit = 1 second of session time, counted from when you press Go live until it ends. Stop any time." },
] as const;

export function HowItWorksSteps({ headingLevel }: { headingLevel: 2 | 3 }) {
  const H = `h${headingLevel}` as const;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {HOW_IT_WORKS_STEPS.map(({ icon: Icon, t, b }) => (
        <Card key={t}>
          <Icon className="h-6 w-6 text-primary" aria-hidden />
          <H className="mt-4 font-semibold">{t}</H>
          <p className="mt-1 text-sm text-muted-foreground">{b}</p>
        </Card>
      ))}
    </div>
  );
}
