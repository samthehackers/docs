/**
 * Referral cookie value: `<code>.<click time in epoch seconds>`. Pure and dependency-free so the edge
 * middleware can import it. The click time lets us refuse to attribute accounts that already existed
 * when the link was clicked.
 */
import { REFERRAL } from "@/lib/plans";

const VALUE = /^([a-f0-9]{8})\.(\d{9,11})$/;
const FUTURE_SKEW_MS = 5 * 60_000;

export function makeRefCookie(code: string, now = new Date()): string | null {
  return REFERRAL.codePattern.test(code) ? `${code}.${Math.floor(now.getTime() / 1000)}` : null;
}

export function parseRefCookie(value: string | undefined | null, now = new Date()): { code: string; clickedAt: Date } | null {
  const m = value?.match(VALUE);
  if (!m) return null;
  const clickedAt = new Date(Number(m[2]) * 1000);
  if (clickedAt.getTime() > now.getTime() + FUTURE_SKEW_MS) return null; // forged/future timestamps are ignored
  return { code: m[1], clickedAt };
}
