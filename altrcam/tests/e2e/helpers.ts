import postgres from "postgres";
import http from "node:http";
import { createHmac } from "node:crypto";

export const sql = () => postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });

/** Mock of Paystack's GET /transaction/verify/:ref (the app re-verifies every webhook server-to-server). */
export function startPaystackMock(port: number, tx: { amount: number; currency: string; userId: string; product: string }) {
  const server = http.createServer((req, res) => {
    const ref = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: true, data: { reference: ref, status: "success", amount: tx.amount, currency: tx.currency, metadata: { userId: tx.userId, product: tx.product }, customer: { email: "x@example.com" } } }));
  });
  return new Promise<http.Server>((r) => server.listen(port, () => r(server)));
}

export function signPaystack(body: string) {
  return createHmac("sha512", process.env.PAYSTACK_SECRET_KEY!).update(body).digest("hex");
}
