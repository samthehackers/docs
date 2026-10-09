export const metadata = { title: "Terms of Service" };

export default function Terms() {
  return (
    <article className="mx-auto max-w-3xl space-y-4 px-4 py-16 text-sm leading-relaxed text-muted-foreground">
      <h1 className="text-4xl font-bold text-foreground">Terms of Service</h1>
      <p className="rounded-md border border-accent/40 p-3">Template text. Have it reviewed by counsel and replace placeholders before launch.</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">1. The service</h2>
      <p>AltrCam transforms your live webcam video using AI. Access requires an account and credits, where 1 credit equals 1 second of live transformed video, counted from when the transformed video first appears until the session ends; time spent connecting is not counted, and a session that never connects uses no credits.</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">2. Acceptable use</h2>
      <p>You may not impersonate a real person to deceive or defraud, create sexual or abusive content, depict minors inappropriately, harass others, or break the law. We may suspend accounts that do.</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">3. Payments and credits</h2>
      <p>Subscriptions renew until cancelled. Monthly credits expire at the end of each cycle; purchased top-ups do not expire. Except where required by law, payments are non-refundable.</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">4. Your content</h2>
      <p>You keep ownership of what you upload and capture, and you are responsible for having the rights to it.</p>
      <h2 className="pt-4 text-lg font-semibold text-foreground">5. Liability</h2>
      <p>The service is provided as is. To the extent permitted by law, we are not liable for indirect or consequential losses.</p>
    </article>
  );
}
