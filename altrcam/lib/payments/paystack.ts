import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import type { PaymentProvider, VerifiedPayment } from "./provider";
import { PRODUCTS } from "@/lib/plans";

// Overridable so e2e tests can point server-to-server verification at a local mock.
const API = process.env.PAYSTACK_API_URL ?? "https://api.paystack.co";

export function hmacSha512Hex(data: string, secret: string) {
  return createHmac("sha512", secret).update(data).digest("hex");
}

export function safeEqualHex(a: string, b: string) {
  const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export function paystackSignatureValid(rawBody: string, header: string | null, secret: string) {
  if (!header) return false;
  return safeEqualHex(hmacSha512Hex(rawBody, secret), header.toLowerCase());
}

async function ps<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
  if (!res.ok || json.status === false) throw new Error(`Paystack ${path}: ${json.message ?? res.status}`);
  return json.data as T;
}

export const paystack: PaymentProvider = {
  name: "paystack",

  async createCheckout({ userId, email, product, reference, amountMinor, currency }) {
    const p = PRODUCTS[product];
    const plan = product === "PRO_MONTHLY" ? process.env.PAYSTACK_PLAN_PRO_MONTHLY : product === "PRO_YEARLY" ? process.env.PAYSTACK_PLAN_PRO_YEARLY : undefined;
    const data = await ps<{ authorization_url: string; reference: string }>("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email, amount: amountMinor, currency, reference,
        callback_url: `${process.env.NEXT_PUBLIC_APP_URL}/billing/success?ref=${encodeURIComponent(reference)}`,
        metadata: { userId, product, kind: p.kind },
        ...(plan ? { plan } : {}),
      }),
    });
    return { url: data.authorization_url, reference: data.reference };
  },

  async verifyWebhook(req) {
    const raw = await req.text();
    if (!paystackSignatureValid(raw, req.headers.get("x-paystack-signature"), process.env.PAYSTACK_SECRET_KEY ?? "")) return null;
    let body: { event: string; data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { body = JSON.parse(raw); } catch { return null; }
    const ref = (body.data?.reference as string | undefined) ?? null;
    // Paystack sends no event id; identical redeliveries have identical bodies.
    const eventId = `paystack:${body.event}:${createHash("sha256").update(raw).digest("hex")}`;
    return { eventId, type: body.event, reference: ref, payload: body };
  },

  async verifyTransaction(reference): Promise<VerifiedPayment> {
    const d = await ps<any>(`/transaction/verify/${encodeURIComponent(reference)}`); // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      reference: d.reference,
      status: d.status === "success" ? "success" : d.status === "failed" || d.status === "abandoned" ? "failed" : "pending",
      amountMinor: d.amount,
      currency: String(d.currency).toUpperCase(),
      metadata: typeof d.metadata === "object" && d.metadata ? { userId: d.metadata.userId, product: d.metadata.product } : {},
      customerEmail: d.customer?.email,
      planCode: d.plan_object?.plan_code ?? d.plan?.plan_code,
    };
  },

  async cancelSubscription(code, token) {
    if (!token) throw new Error("email token required to disable Paystack subscription");
    await ps("/subscription/disable", { method: "POST", body: JSON.stringify({ code, token }) });
  },
};
