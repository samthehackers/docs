/**
 * /auth/callback (PKCE `code`) and /auth/confirm (`token_hash` + `type`): where they send people, that `next` can't be
 * turned into an open redirect, and that every failure lands on /sign-in with a friendly message instead of a dead end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  exchange: vi.fn(async (_code: string) => ({ error: null as null | { code?: string; message: string } })),
  verify: vi.fn(async (_p: { type: string; token_hash: string }) => ({ error: null as null | { code?: string; message: string } })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { exchangeCodeForSession: h.exchange, verifyOtp: h.verify } }),
}));

import { GET as callback } from "@/app/auth/callback/route";
import { GET as confirm } from "@/app/auth/confirm/route";
import { authErrorMessage, safeNextPath } from "@/lib/safe-redirect";

const ORIGIN = "https://altrcam.vercel.app";
const go = async (handler: (r: Request) => Promise<Response>, query: string) => {
  const res = await handler(new Request(`${ORIGIN}${query}`));
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  return new URL(res.headers.get("location")!);
};

beforeEach(() => { h.exchange.mockClear(); h.verify.mockClear(); h.exchange.mockResolvedValue({ error: null }); h.verify.mockResolvedValue({ error: null }); vi.spyOn(console, "error").mockImplementation(() => {}); });

describe("safeNextPath", () => {
  it.each([
    ["/settings/password", "/settings/password"],
    ["/billing?x=1#y", "/billing?x=1#y"],
    ["/", "/"],
  ])("keeps the same-origin path %s", (next, want) => expect(safeNextPath(next)).toBe(want));

  it.each([
    "//evil.com", "//evil.com/dashboard", "/\\evil.com", "/\\/evil.com", "\\\\evil.com", "https://evil.com", "http:/evil.com",
    "javascript:alert(1)", "evil.com", "/%2F%2Fevil.com", "%2F%2Fevil.com", "/%5Cevil.com", "/\tevil", "/\n/evil.com", "/%0d%0a//evil.com", "", null, undefined,
  ])("refuses %j and falls back to /dashboard", (next) => expect(safeNextPath(next as string)).toBe("/dashboard"));

  it("uses the fallback it is given", () => expect(safeNextPath("//x", "/settings/password")).toBe("/settings/password"));
});

describe("/auth/callback", () => {
  it("exchanges the code and goes to the dashboard by default", async () => {
    const to = await go(callback, "/auth/callback?code=abc");
    expect(h.exchange).toHaveBeenCalledWith("abc");
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe("/dashboard");
  });
  it("follows a same-origin next (the password-reset link)", async () => {
    expect((await go(callback, "/auth/callback?code=abc&next=/settings/password")).pathname).toBe("/settings/password");
  });
  it.each(["//evil.com", "/\\evil.com", "https://evil.com", "/%2F%2Fevil.com"])("never leaves the site for next=%s", async (next) => {
    const to = await go(callback, `/auth/callback?code=abc&next=${encodeURIComponent(next)}`);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe("/dashboard");
  });
  it("an expired or reused link goes to sign-in with a message, and no session is attempted", async () => {
    const to = await go(callback, "/auth/callback?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    expect(to.pathname).toBe("/sign-in");
    expect(to.searchParams.get("error")).toBe("link_expired");
    expect(h.exchange).not.toHaveBeenCalled();
  });
  it("a failed code exchange goes to sign-in instead of a signed-out dashboard redirect loop", async () => {
    h.exchange.mockResolvedValue({ error: { code: "bad_code_verifier", message: "code challenge does not match previously saved code verifier" } });
    const to = await go(callback, "/auth/callback?code=abc&next=/settings/password");
    expect(to.pathname).toBe("/sign-in");
    expect(authErrorMessage(to.searchParams.get("error")!)).toBeTruthy();
  });
  it("a link opened in another browser (no PKCE verifier) says so instead of 'invalid'", async () => {
    h.exchange.mockResolvedValue({ error: { code: "pkce_code_verifier_not_found", message: "PKCE code verifier not found in storage." } });
    const to = await go(callback, "/auth/callback?code=abc");
    expect(to.searchParams.get("error")).toBe("other_browser");
    expect(authErrorMessage("other_browser")).toMatch(/it is confirmed: sign in/);
  });
  it("no code at all is an invalid link", async () => {
    expect((await go(callback, "/auth/callback")).searchParams.get("error")).toBe("link_invalid");
  });
  it("the error text from the URL is never echoed: only a known code reaches the sign-in page", async () => {
    const to = await go(callback, "/auth/callback?error=<script>alert(1)</script>");
    expect(["auth_failed", "link_invalid", "link_expired", "access_denied"]).toContain(to.searchParams.get("error"));
    expect(authErrorMessage("<script>")).toBeNull();
  });
});

describe("/auth/confirm (token_hash email templates)", () => {
  it("verifies a signup token and goes to the dashboard", async () => {
    const to = await go(confirm, "/auth/confirm?token_hash=th&type=signup");
    expect(h.verify).toHaveBeenCalledWith({ type: "signup", token_hash: "th" });
    expect(to.pathname).toBe("/dashboard");
  });
  it("a recovery token goes to the new-password page, even without next", async () => {
    expect((await go(confirm, "/auth/confirm?token_hash=th&type=recovery")).pathname).toBe("/settings/password");
  });
  it("refuses an off-site next", async () => {
    const to = await go(confirm, `/auth/confirm?token_hash=th&type=recovery&next=${encodeURIComponent("//evil.com")}`);
    expect(to.origin).toBe(ORIGIN);
    expect(to.pathname).toBe("/settings/password");
  });
  it("missing or unknown type, or a failed verification, goes to sign-in with a message", async () => {
    expect((await go(confirm, "/auth/confirm?token_hash=th")).pathname).toBe("/sign-in");
    expect((await go(confirm, "/auth/confirm?token_hash=th&type=admin")).pathname).toBe("/sign-in");
    h.verify.mockResolvedValue({ error: { code: "otp_expired", message: "Token has expired or is invalid" } });
    const to = await go(confirm, "/auth/confirm?token_hash=th&type=signup");
    expect(to.pathname).toBe("/sign-in");
    expect(to.searchParams.get("error")).toBe("link_expired");
  });
});
