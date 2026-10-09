import { describe, expect, it } from "vitest";
import { buildCsp, clerkHostFromKey } from "@/lib/csp";

const key = (host: string, kind: "test" | "live" = "live") => `pk_${kind}_${Buffer.from(`${host}$`).toString("base64")}`;
const directive = (csp: string, name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
const sources = (csp: string, name: string) => directive(csp, name).split(" ").slice(1);

describe("clerkHostFromKey", () => {
  it("decodes production and dev keys", () => {
    expect(clerkHostFromKey(key("clerk.altrcam.com"))).toBe("clerk.altrcam.com");
    expect(clerkHostFromKey(key("fancy-lion-12.clerk.accounts.dev", "test"))).toBe("fancy-lion-12.clerk.accounts.dev");
  });
  it("rejects garbage so nothing odd reaches the header", () => {
    for (const bad of [undefined, "", "sk_live_abc", "pk_live_", "pk_live_!!!!", key("evil.com; script-src *"), key("nodot"), key("a b.com")]) {
      expect(clerkHostFromKey(bad)).toBeNull();
    }
  });
});

describe("buildCsp", () => {
  it("allows the production Clerk host to load clerk-js and call its API", () => {
    const csp = buildCsp({ clerkPublishableKey: key("clerk.altrcam.com") });
    expect(sources(csp, "script-src")).toContain("https://clerk.altrcam.com");
    expect(sources(csp, "connect-src")).toContain("https://clerk.altrcam.com");
  });
  it("without a key it still builds and adds no Clerk custom host", () => {
    const csp = buildCsp();
    expect(csp).not.toMatch(/clerk\.altrcam/);
    expect(sources(csp, "script-src")).toContain("https://*.clerk.accounts.dev");
  });
  it("keeps the fal realtime socket (bare wss://fal.run) allowed via the wss: scheme source", () => {
    expect(sources(buildCsp(), "connect-src")).toContain("wss:");
  });
  it("is locked down where it matters", () => {
    const csp = buildCsp({ clerkPublishableKey: key("clerk.altrcam.com") });
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(sources(csp, "script-src")).not.toContain("*");
    expect(sources(csp, "script-src")).not.toContain("'unsafe-eval'");
  });
  it("an injected key can't smuggle extra directives into the header", () => {
    const csp = buildCsp({ clerkPublishableKey: key("evil.com; script-src *") });
    expect(csp).not.toContain("evil.com");
  });
});
