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

describe("an unset secret never validates anything", () => {
  // process.env.X ?? "" is what the callers pass when the variable is missing, and an HMAC with an empty key is
  // perfectly computable by anyone: without this a deployment missing its secret would accept forged webhooks.
  const body = JSON.stringify({ event: "charge.success", data: { reference: "x" } });
  it("Paystack: a signature made with the empty key is rejected", () => {
    expect(paystackSignatureValid(body, hmacSha512Hex(body, ""), "")).toBe(false);
  });
  it("NOWPayments: a signature made with the empty key is rejected", () => {
    const payload = { payment_status: "finished", order_id: "o1", payment_id: 5 };
    expect(nowpaymentsSignatureValid(payload, hmacSha512Hex(JSON.stringify(sortKeysDeep(payload)), ""), "")).toBe(false);
  });
  it("a real secret still works (the guard is not a blanket rejection)", () => {
    expect(paystackSignatureValid(body, hmacSha512Hex(body, "sk_live_x"), "sk_live_x")).toBe(true);
  });
});
