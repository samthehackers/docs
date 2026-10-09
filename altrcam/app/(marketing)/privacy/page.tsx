export const metadata = { title: "Privacy Policy" };

export default function Privacy() {
  return (
    <article className="mx-auto max-w-3xl space-y-4 px-4 py-16 text-sm leading-relaxed text-muted-foreground">
      <h1 className="text-4xl font-bold text-foreground">Privacy Policy</h1>
      <p className="rounded-md border border-accent/40 p-3">Template text. Have it reviewed by counsel and replace placeholders before launch.</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">What we collect</h2>
      <p>Account details (via Clerk), usage and credit records, payment references from our processors, and any images you choose to save (clips you record are downloaded to your own device and are not stored by us).</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">Camera video</h2>
      <p>The Studio asks for camera access so you can see a local preview; that preview stays in your browser. Video is sent to our AI provider for realtime processing only after you press Go live, and it is not recorded by default.</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">Processors</h2>
      <p>We use Clerk (authentication), Supabase (database and storage), fal.ai (AI inference), Paystack and NOWPayments (payments), Resend (email) and Upstash (rate limiting).</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">Retention and deletion</h2>
      <p>You can delete your account from Settings. Data is removed or anonymised, except records we must keep for legal or accounting reasons.</p>
    </article>
  );
}
