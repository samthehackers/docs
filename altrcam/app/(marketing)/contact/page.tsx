import Link from "next/link";

export const metadata = { title: "Contact" };

const email = process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? "support@altrcam.com";

export default function Contact() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-4xl font-bold">Contact</h1>
      <p className="mt-4 text-muted-foreground">
        Email us at <a className="text-primary underline" href={`mailto:${email}`}>{email}</a>. Signed-in users can also open a ticket from{" "}
        <Link href="/support" prefetch={false} className="text-primary underline">Support</Link>.
      </p>
    </div>
  );
}
