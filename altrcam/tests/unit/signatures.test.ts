import { describe, expect, it } from "vitest";
import { hmacSha512Hex, paystackSignatureValid } from "@/lib/payments/paystack";
import { nowpaymentsSignatureValid, sortKeysDeep } from "@/lib/payments/nowpayments";

describe("Paystack signature", () => {
  const body = JSON.stringify({ event: "charge.success", data: { reference: "x" } });
  const sig = hmacSha512Hex(body, "sk_test");
  it("accepts a valid HMAC-SHA512", () => expect(paystackSignatureValid(body, sig, "sk_test")).toBe(true));
  it("rejects tampered body", () => expect(paystackSignatureValid(body + " ", sig, "sk_test")).toBe(false));
  it("rejects wrong secret and missing header", () => {
    expect(paystackSignatureValid(body, sig, "other")).toBe(false);
    expect(paystackSignatureValid(body, null, "sk_test")).toBe(false);
    expect(paystackSignatureValid(body, "abc", "sk_test")).toBe(false);
  });
});

describe("NOWPayments signature", () => {
  const payload = { payment_status: "finished", order_id: "o1", payment_id: 5, nested: { b: 1, a: 2 } };
  const sig = hmacSha512Hex(JSON.stringify(sortKeysDeep(payload)), "ipn");
  it("signs over key-sorted JSON regardless of incoming key order", () => {
    const reordered = { nested: { a: 2, b: 1 }, payment_id: 5, order_id: "o1", payment_status: "finished" };
    expect(nowpaymentsSignatureValid(reordered, sig, "ipn")).toBe(true);
  });
  it("rejects a modified payload", () => {
    expect(nowpaymentsSignatureValid({ ...payload, payment_status: "waiting" }, sig, "ipn")).toBe(false);
    expect(nowpaymentsSignatureValid(payload, null, "ipn")).toBe(false);
  });
});
