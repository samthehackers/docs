import { PollStatus } from "@/components/billing/poll-status";

export const metadata = { title: "Payment" };

export default async function Success({ searchParams }: { searchParams: Promise<{ ref?: string; reference?: string; trxref?: string }> }) {
  const sp = await searchParams;
  const ref = sp.ref ?? sp.reference ?? sp.trxref;
  return <div className="grid min-h-[50vh] place-items-center">{ref ? <PollStatus reference={ref} /> : <p>Missing payment reference.</p>}</div>;
}
