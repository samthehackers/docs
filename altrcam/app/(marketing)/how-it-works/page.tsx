import { AvailabilityNotice } from "@/components/availability-notice";
import { HowItWorksSteps } from "@/components/how-it-works-steps";
import { SignupClosedNotice } from "@/components/signup-closed";
import { StudioCta } from "@/components/studio-cta";
import { accountsOpen } from "@/lib/config";
import { viewerId } from "@/lib/viewer";

export const metadata = { title: "How it works" };

export default async function HowItWorks() {
  const signedIn = (await viewerId()) !== null;
  const open = accountsOpen();
  return (
    <div className="mx-auto max-w-4xl px-4 py-16">
      <h1 className="text-center text-4xl font-bold">How <span className="gradient-text">AltrCam</span> works</h1>
      <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">From webcam to a restyled live video in four steps.</p>
      <AvailabilityNotice className="mt-8" />
      <div className="mt-12"><HowItWorksSteps headingLevel={2} /></div>
      <div className="mt-12 text-center">
        <StudioCta signedIn={signedIn} accountsOpen={open} />
        {!signedIn && !open && <SignupClosedNotice />}
      </div>
    </div>
  );
}
