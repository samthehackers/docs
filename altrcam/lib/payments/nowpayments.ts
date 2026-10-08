import type { PaymentProvider, VerifiedPayment } from "./provider";
import { hmacSha512Hex, safeEqualHex } from "./paystack";

const API = "https://api.nowpayments.io/v1";

export function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeysDeep((v as Record<string, unknown>)[k])]));
  }
  return v;
}

export function nowpaymentsSignatureValid(body: unknown, header: string | null, secret: string) {
  if (!header) return false;
  return safeEqualHex(hmacSha512Hex(JSON.stringify(sortKeysDeep(body)), secret), header.toLowerCase());
}

async function np<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "x-api-key": process.env.NOWPAYMENTS_API_KEY ?? "", "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(`NOWPayments ${path}: ${(json as { message?: string }).message ?? res.status}`);
  return json;
}

export const nowpayments: PaymentProvider = {
  name: "nowpayments",

  async createCheckout({ product, reference, amountMinor, currency }) {
    const app = process.env.NEXT_PUBLIC_APP_URL;
    const inv = await np<{ invoice_url: string }>("/invoice", {
      method: "POST",
      body: JSON.stringify({
        price_amount: amountMinor / 100,
        price_currency: currency.toLowerCase(),
        order_id: reference,
        order_description: `AltrCam ${product}`,
        ipn_callback_url: `${app}/api/webhooks/nowpayments`,
        success_url: `${app}/billing/success?ref=${encodeURIComponent(reference)}`,
        cancel_url: `${app}/billing`,
      }),
    });
    return { url: inv.invoice_url, reference };
  },

  async verifyWebhook(req) {
    let body: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    try { body = JSON.parse(await req.text()); } catch { return null; }
    if (!nowpaymentsSignatureValid(body, req.headers.get("x-nowpayments-sig"), process.env.NOWPAYMENTS_IPN_SECRET ?? "")) return null;
    return {
      eventId: `nowpayments:${body.payment_id}:${body.payment_status}`,
      type: String(body.payment_status),
      reference: body.order_id ?? null,
      providerPaymentId: String(body.payment_id),
      payload: body,
    };
  },

  async verifyTransaction(reference, hint): Promise<VerifiedPayment> {
    if (!hint?.providerPaymentId) throw new Error("payment id required");
    const d = await np<any>(`/payment/${encodeURIComponent(hint.providerPaymentId)}`); // eslint-disable-line @typescript-eslint/no-explicit-any
    if (d.order_id !== reference) throw new Error("order mismatch");
    const status = d.payment_status === "finished" ? "success" : d.payment_status === "partially_paid" ? "partial" : ["failed", "expired", "refunded"].includes(d.payment_status) ? "failed" : "pending";
    return {
      reference,
      status,
      amountMinor: Math.round(Number(d.price_amount) * 100),
      currency: String(d.price_currency).toUpperCase(),
      metadata: {},
    };
  },
};
