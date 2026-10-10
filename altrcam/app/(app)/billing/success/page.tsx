import { PollStatus } from "@/components/billing/poll-status";

import { requireAppUser } from "@/lib/session-user";

export const metadata = { title: "Payment" };

export default async function Success({ searchParams }: { searchParams: Promise<{ ref?: string; reference?: string; trxref?: string }> }) {
  await requireAppUser(); // same gate as the other app pages: signed in, email confirmed
  const sp = await searchParams;
  const ref = sp.ref ?? sp.reference ?? sp.trxref;
  return <div className="grid min-h-[50vh] place-items-center">{ref ? <PollStatus reference={ref} /> : <p>Missing payment reference.</p>}</div>;
}
