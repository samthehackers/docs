import Link from "next/link";
import { LIVE_AVAILABILITY } from "@/lib/availability";

export const metadata = { title: "FAQ" };

const faqs = [
  { q: "What is a credit?", a: "One credit is one second of session time, counted from when you press Go live until the session ends. If the connection fails, the seconds spent trying still count." },
  { q: "Do monthly credits roll over?", a: "No. Monthly plan credits refill each cycle. Top-up credits you buy never expire and are used after your monthly credits." },
  { q: "What happens when I run out of credits?", a: "The session stops automatically. You can top up or upgrade from the Billing page and go live again." },
  { q: "Is my video stored?", a: "Live video is processed in realtime and is not recorded by default. Snapshots (every plan) and clips (plans that include recording) are saved only if you choose to capture them." },
  { q: "Where does my video go?", a: "Your camera preview stays in your browser. After you press Go live, your video is sent to a third-party AI service to be transformed and shown back to you. It is not sent before that. See the Privacy Policy for the list of processors." },
  { q: "Is audio used?", a: "No. AltrCam transforms video only. It does not ask for your microphone and no audio is captured or sent." },
  { q: "Does the live video work yet?", a: LIVE_AVAILABILITY.body },
  { q: "What do I need to use it?", a: "A modern desktop browser with a webcam and a stable internet connection. A microphone is not needed." },
  { q: "Which payment methods are supported?", a: "Pro subscriptions are paid through Paystack, which offers cards and other methods depending on your country. Lifetime and top-ups can be paid through Paystack or with cryptocurrency through NOWPayments." },
  { q: "Can I cancel anytime?", a: "Yes. Cancelling stops renewal and your plan stays active until the end of the paid period." },
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
