import type { PaymentProvider, ProviderName } from "./provider";
import { paystack } from "./paystack";
import { nowpayments } from "./nowpayments";

export function getProvider(name: ProviderName): PaymentProvider {
  return name === "paystack" ? paystack : nowpayments;
}
export type { PaymentProvider, ProviderName } from "./provider";
