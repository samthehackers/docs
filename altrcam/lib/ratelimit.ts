import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { HttpError } from "@/lib/api";

const limits = {
  sessionStart: { n: 10, window: "1 m", ms: 60_000 },
  heartbeat: { n: 20, window: "1 m", ms: 60_000 },
  checkout: { n: 10, window: "10 m", ms: 600_000 },
  ticket: { n: 5, window: "10 m", ms: 600_000 },
  upload: { n: 30, window: "10 m", ms: 600_000 },
} as const;
export type LimitName = keyof typeof limits;

const cache = new Map<string, Ratelimit>();

/**
 * Fallback when Upstash is not configured: a sliding window kept in this server instance's memory. It is weaker than
 * Upstash (each serverless instance counts on its own and forgets on a cold start), but it still slows a single abusive
 * client, and, unlike throwing, it does not take support tickets, the Studio and checkout down with a 500.
 */
const memory = new Map<string, number[]>();
let warned = false;
let lastSweep = 0;
function memoryLimit(name: LimitName, key: string, now = Date.now()) {
  if (!warned && process.env.NODE_ENV === "production") {
    warned = true;
    console.warn("[ratelimit] UPSTASH_REDIS_REST_URL/TOKEN not set: using a per-instance in-memory limiter");
  }
  const l = limits[name];
  const id = `${name}:${key}`;
  const hits = (memory.get(id) ?? []).filter((t) => now - t < l.ms);
  if (hits.length >= l.n) { memory.set(id, hits); throw new HttpError(429, "Too many requests, slow down"); }
  hits.push(now);
  memory.set(id, hits);
  // Drop idle keys, but sweep at most once a minute so a busy instance doesn't walk the whole map on every call.
  if (memory.size > 10_000 && now - lastSweep >= 60_000) {
    lastSweep = now;
    for (const [k, v] of memory) if (!v.some((t) => now - t < limits[k.split(":")[0] as LimitName].ms)) memory.delete(k);
  }
}

/** Throws 429 when exceeded. Uses Upstash when configured, else the in-memory fallback above. */
export async function rateLimit(name: LimitName, key: string) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.NODE_ENV !== "production") return; // local dev and tests: no limit
    return memoryLimit(name, key);
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

/** Test hook: forget the in-memory counters. */
export const resetMemoryLimits = () => { memory.clear(); lastSweep = 0; };
/** Test hook: how many keys are tracked. */
export const memoryLimitKeys = () => memory.size;
