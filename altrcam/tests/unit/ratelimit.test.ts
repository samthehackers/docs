/**
 * Production has no Upstash. The limiter used to throw "Rate limiter not configured" there, which turned every support
 * ticket, Studio session start/heartbeat, upload and checkout into a 500. Now it falls back to an in-memory window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rateLimit, resetMemoryLimits } from "@/lib/ratelimit";
import { HttpError } from "@/lib/api";

const env = { ...process.env };
beforeEach(() => {
  resetMemoryLimits();
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  (process.env as Record<string, string>).NODE_ENV = "production";
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => { process.env = { ...env }; });

describe("rateLimit without Upstash in production", () => {
  it("does not throw a 500-style error for normal use", async () => {
    await expect(rateLimit("ticket", "u1")).resolves.toBeUndefined();
  });
  it("still limits one user (429 after the window's allowance) without affecting another", async () => {
    for (let i = 0; i < 5; i++) await rateLimit("ticket", "u1");
    const err = await rateLimit("ticket", "u1").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    await expect(rateLimit("ticket", "u2")).resolves.toBeUndefined();
    await expect(rateLimit("checkout", "u1")).resolves.toBeUndefined();
  });
});
