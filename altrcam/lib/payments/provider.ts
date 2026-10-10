import type { ProductId } from "@/lib/plans";

export type ProviderName = "paystack" | "nowpayments";

export interface VerifiedEvent {
  /** Stable id used for webhook idempotency. */
  eventId: string;
  type: string;
  reference: string | null;
  providerPaymentId?: string;
  payload: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface VerifiedPayment {
  reference: string;
  status: "success" | "failed" | "pending" | "partial";
  amountMinor: number;
  currency: string;
  metadata: { userId?: string; product?: string };
  customerEmail?: string;
  /** Paystack customer_code (CUS_...), when the provider has one. */
  customerCode?: string;
  planCode?: string;
  subscriptionCode?: string;
}

export interface PaymentProvider {
  readonly name: ProviderName;
  createCheckout(input: { userId: string; email: string; product: ProductId; reference: string; amountMinor: number; currency: string }): Promise<{ url: string; reference: string }>;
  /** Signature check on the raw body. Returns null when the signature is invalid. */
  verifyWebhook(req: Request): Promise<VerifiedEvent | null>;
  /** Server-to-server re-check; never trust webhook payload amounts. */
  verifyTransaction(reference: string, hint?: { providerPaymentId?: string }): Promise<VerifiedPayment>;
  cancelSubscription?(providerSubId: string, token?: string): Promise<void>;
}
