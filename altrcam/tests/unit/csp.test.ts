import { describe, expect, it } from "vitest";
import { buildCsp, supabaseOrigin } from "@/lib/csp";

const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
const sources = (csp: string, name: string) => directive(csp, name).split(" ").slice(1);

describe("supabaseOrigin", () => {
  it("takes the origin of a hosted, custom or local Supabase URL", () => {
    expect(supabaseOrigin("https://abc.supabase.co")).toBe("https://abc.supabase.co");
    expect(supabaseOrigin("https://auth.altrcam.com/")).toBe("https://auth.altrcam.com");
    expect(supabaseOrigin("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
  });
  it("rejects garbage so nothing odd reaches the header", () => {
    for (const bad of [undefined, "", "not a url", "javascript:alert(1)", "ftp://x.com", "https://evil.com; script-src *"]) {
      const o = supabaseOrigin(bad);
      expect(o === null || !o.includes(";")).toBe(true);
    }
    expect(supabaseOrigin("javascript:alert(1)")).toBeNull();
  });
});

describe("buildCsp", () => {
  it("lets the browser call hosted Supabase Auth, and a local or custom Supabase origin when configured", () => {
    expect(sources(buildCsp(), "connect-src")).toContain("https://*.supabase.co");
    expect(sources(buildCsp({ supabaseUrl: "http://127.0.0.1:54321" }), "connect-src")).toContain("http://127.0.0.1:54321");
    expect(sources(buildCsp({ supabaseUrl: "https://abc.supabase.co" }), "connect-src")).not.toContain("https://abc.supabase.co"); // wildcard covers it
  });
  it("has no third-party auth hosts left over", () => {
    expect(buildCsp()).not.toMatch(/accounts\.dev|challenges\.cloudflare/);
  });
  it("keeps the fal realtime socket (bare wss://fal.run) allowed via the wss: scheme source", () => {
    expect(sources(buildCsp(), "connect-src")).toContain("wss:");
  });
  it("is locked down where it matters", () => {
    const csp = buildCsp({ supabaseUrl: "https://abc.supabase.co" });
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(sources(csp, "script-src")).not.toContain("*");
    expect(sources(csp, "script-src")).not.toContain("'unsafe-eval'");
  });
  it("an injected URL can't smuggle extra directives into the header", () => {
    const csp = buildCsp({ supabaseUrl: "https://evil.com; script-src *" });
    expect(sources(csp, "script-src")).not.toContain("*");
    expect(csp.split("; ").filter((d) => d.startsWith("script-src")).length).toBe(1);
  });
});
