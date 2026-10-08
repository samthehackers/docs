import { processWebhook } from "@/lib/payments/process";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const r = await processWebhook("paystack", req);
  return new Response(r.body, { status: r.status });
}
