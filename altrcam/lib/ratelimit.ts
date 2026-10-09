import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { HttpError } from "@/lib/api";

const limits = {
  sessionStart: { n: 10, window: "1 m" },
  heartbeat: { n: 20, window: "1 m" },
  live: { n: 20, window: "1 m" },
  checkout: { n: 10, window: "10 m" },
  ticket: { n: 5, window: "10 m" },
  upload: { n: 30, window: "10 m" },
} as const;
export type LimitName = keyof typeof limits;

const cache = new Map<string, Ratelimit>();

/** Throws 429 when exceeded. No-op when Upstash is not configured (local dev only; env is enforced in prod). */
export async function rateLimit(name: LimitName, key: string) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.NODE_ENV === "production") throw new Error("Rate limiter not configured");
    return;
  }
  let rl = cache.get(name);
  if (!rl) {
    const l = limits[name];
    rl = new Ratelimit({ redis: new Redis({ url, token }), limiter: Ratelimit.slidingWindow(l.n, l.window), prefix: `altrcam:${name}` });
    cache.set(name, rl);
  }
  const res = await rl.limit(key);
  if (!res.success) throw new HttpError(429, "Too many requests, slow down");
}
