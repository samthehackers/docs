import Link from "next/link";
import { AvailabilityNotice } from "@/components/availability-notice";
import { LIVE_AVAILABILITY } from "@/lib/availability";
import { PAYMENT_METHODS_TEXT } from "@/lib/public-copy";

export const metadata = { title: "FAQ" };

const faqs = [
  { q: "What is a credit?", a: "One credit is one second of session time, counted from when you press Go live until the session ends. If the connection fails, the seconds spent trying still count." },
  { q: "Do monthly credits roll over?", a: "No. Monthly plan credits refill each cycle. Top-up credits you buy never expire and are used after your monthly credits." },
  { q: "What happens when I run out of credits?", a: "The session stops automatically. You can top up or upgrade from the Billing page and go live again." },
  { q: "Is my video stored?", a: "AltrCam does not record your live video. Snapshots are saved to your History when you press Snapshot (every plan). Clips, on plans that include recording, are downloaded to your own device; AltrCam does not store them. What the third-party AI service does with video it receives is governed by that service's own terms, which this site does not yet describe." },
  { q: "Where does my video go?", a: "Your camera preview stays in your browser. After you press Go live, your video is sent to a third-party AI service to be transformed and shown back to you. It is not sent before that. A reference image you attach is uploaded to AltrCam's storage when you pick it and sent to the AI service as a signed link. The Privacy Policy (still template text) lists the processors we use." },
  { q: "Is audio used?", a: "No. AltrCam transforms video only. It does not ask for your microphone and no audio is captured or sent." },
  { q: "Does the live video work yet?", a: LIVE_AVAILABILITY.body },
  { q: "What do I need to use it?", a: "A modern desktop browser with a webcam and a stable internet connection. A microphone is not needed." },
  { q: "Which payment methods are supported?", a: PAYMENT_METHODS_TEXT },
  { q: "Can I cancel a Pro subscription?", a: "Yes, from the Billing page. Cancelling stops renewal and Pro stays active until the end of the period you paid for. If no Cancel button shows, contact us. Lifetime and top-ups are one-time purchases with nothing to cancel." },
  { q: "Can I delete my account?", a: "Yes, from Settings. Your data is removed in line with our Privacy Policy." },
];

export default function Faq() {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map(({ q, a }) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })),
  };
  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <h1 className="text-center text-4xl font-bold">Frequently asked <span className="gradient-text">questions</span></h1>
      <AvailabilityNotice className="mt-6" />
      <div className="mt-10 space-y-3">
        {faqs.map(({ q, a }) => (
          <details key={q} className="group rounded-lg border bg-card p-5">
            <summary className="cursor-pointer font-medium">{q}</summary>
            <p className="mt-2 text-sm text-muted-foreground">{a}</p>
          </details>
        ))}
      </div>
      <p className="mt-10 text-center text-sm text-muted-foreground">
        Still stuck? <Link href="/contact" className="text-primary underline">Contact us</Link>.
      </p>
    </div>
  );
}
