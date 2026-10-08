import { afterEach, describe, expect, it } from "vitest";
import { requireCron, HttpError } from "@/lib/api";

const saved = process.env.CRON_SECRET;
afterEach(() => { if (saved === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved; });
const req = (auth?: string) => new Request("http://x/api/cron/stale-sessions", { headers: auth === undefined ? {} : { authorization: auth } });
const status = (r: Request) => { try { requireCron(r); return 200; } catch (e) { return e instanceof HttpError ? e.status : -1; } };

describe("requireCron", () => {
  const SECRET = "0123456789abcdef0123456789abcdef";

  it("accepts exactly 'Bearer <secret>'", () => {
    process.env.CRON_SECRET = SECRET;
    expect(status(req(`Bearer ${SECRET}`))).toBe(200);
  });
  it("rejects a missing, empty or wrong header", () => {
    process.env.CRON_SECRET = SECRET;
    for (const h of [undefined, "", "Bearer ", `Bearer ${SECRET}x`, `Bearer ${SECRET.slice(1)}`, `bearer ${SECRET}`, SECRET, `Basic ${SECRET}`, "Bearer wrong-secret-of-another-length"]) {
      expect(status(req(h)), String(h)).toBe(401);
    }
  });
  it("rejects a same-length wrong secret (the constant-time path)", () => {
    process.env.CRON_SECRET = SECRET;
    expect(status(req(`Bearer ${"f".repeat(SECRET.length)}`))).toBe(401);
  });
  it("is closed when no secret is configured, even for the literal 'Bearer undefined'", () => {
    delete process.env.CRON_SECRET;
    for (const h of [undefined, "Bearer undefined", "Bearer ", "Bearer"]) expect(status(req(h)), String(h)).toBe(401);
    process.env.CRON_SECRET = "";
    expect(status(req("Bearer "))).toBe(401);
  });
  it("handles non-ASCII (Latin-1) header bytes without throwing, including ones whose UTF-8 length matches the secret", () => {
    process.env.CRON_SECRET = SECRET;
    expect(status(req("Bearer \u00e9\u00e8\u00ff"))).toBe(401);
    // 'e-acute' is 1 char but 2 UTF-8 bytes: a header of the right byte length but different content must still fail
    expect(status(req(`Bearer ${"\u00e9".repeat(SECRET.length / 2)}`))).toBe(401);
  });
});
