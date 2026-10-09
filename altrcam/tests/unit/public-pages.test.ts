/**
 * The real public pages (/, /how-it-works, /pricing, /faq), rendered to HTML. Only the sign-in lookup is stubbed.
 * Checks what a visitor reads: the live-video status, where the buttons go, and that the claims removed in the copy audit
 * stay removed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import type { ReactElement } from "react";

const h = vi.hoisted(() => ({ me: null as string | null, authCalls: 0 }));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => { h.authCalls++; return { userId: h.me }; } }));

import Landing from "@/app/(marketing)/page";
import HowItWorks from "@/app/(marketing)/how-it-works/page";
import Pricing from "@/app/(marketing)/pricing/page";
import Faq from "@/app/(marketing)/faq/page";
import { HOW_IT_WORKS_STEPS } from "@/components/how-it-works-steps";
import { LIVE_AVAILABILITY } from "@/lib/availability";
import { viewerId } from "@/lib/viewer";

beforeAll(() => { (globalThis as { React?: unknown }).React = React; }); // pages are JSX; Next compiles them with the automatic runtime
const ENV = { ...process.env };
beforeEach(() => {
  h.me = null; h.authCalls = 0;
  delete process.env.DATABASE_URL; // plans fall back to the defaults
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_x"; process.env.CLERK_SECRET_KEY = "sk_test_x";
  process.env.PRICE_PRO_MONTHLY = "1500000"; process.env.PRICE_PRO_YEARLY = "15000000"; process.env.PRICE_LIFETIME = "9900000";
  process.env.PRICE_TOPUP_1K = "300000"; process.env.PRICE_TOPUP_5K = "1200000"; process.env.PRICE_TOPUP_15K = "3000000";
  process.env.PRICE_CURRENCY = "NGN";
  delete process.env.PRICING_APPROVED;
});
afterEach(() => { process.env = { ...ENV }; });

const html = (el: ReactElement) => renderToStaticMarkup(el);
const plain = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const hrefs = (s: string) => [...s.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
const count = (s: string, needle: string) => s.split(needle).length - 1;

const landing = async () => html((await Landing()) as ReactElement);
const how = async () => html((await HowItWorks()) as ReactElement);
const pricing = async () => html((await Pricing()) as ReactElement);
const faq = () => html(Faq() as ReactElement);

const REMOVED_CLAIMS = [
  /your face, their look/i, /post it anywhere/i, /no waiting/i, /magic/i, /instantly/i, /\bpopular\b/i,
  /anyone, anywhere/i, /high resolution/i, /standard resolution/i, /testimonial|trusted by/i,
];

describe("the live-video status", () => {
  it("shows on the landing page, under the hero buttons, and on how-it-works", async () => {
    const l = await landing();
    expect(count(plain(l), LIVE_AVAILABILITY.body)).toBe(1);
    expect(l.indexOf("live-availability")).toBeGreaterThan(l.indexOf("See pricing"));
    expect(l.indexOf("live-availability")).toBeLessThan(l.indexOf("Become anyone"));
    expect(count(plain(await how()), LIVE_AVAILABILITY.body)).toBe(1);
  });
  it("is announced as a note, not hidden or buried", async () => {
    expect(await landing()).toMatch(/<p role="note"[^>]*data-testid="live-availability"/);
  });
  it("is written in one place only", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = path.join(dir, f);
        if (statSync(p).isDirectory()) { if (!["node_modules", ".next"].includes(f)) walk(p); continue; }
        if (/\.(tsx?|md)$/.test(f) && readFileSync(p, "utf8").includes("tested end to end against the real service")) hits.push(path.relative(".", p));
      }
    };
    for (const d of ["app", "components", "lib"]) walk(d);
    expect(hits).toEqual(["lib/availability.ts"]);
  });
  it("is the answer to 'Does the live video work yet?' in the FAQ", () => {
    const f = plain(faq());
    expect(f).toContain("Does the live video work yet?");
    expect(f).toContain(LIVE_AVAILABILITY.body);
  });
});

describe("the landing page", () => {
  it("keeps the tagline and explains what happens, including where the video goes", async () => {
    const t = plain(await landing());
    expect(t).toContain("Be anyone.");
    expect(t).toMatch(/reference image/);
    expect(t).toMatch(/sent to a third-party realtime AI model/);
    expect(t).toMatch(/only after you press Go live/);
    expect(t).toMatch(/Video only: no audio/);
    expect(t).not.toMatch(/Decart|Lucy/); // the model credit stays in the footer
  });
  it("has the four-step strip, the same text as /how-it-works, with a link to the full page", async () => {
    const l = await landing(), hw = await how();
    for (const s of HOW_IT_WORKS_STEPS) { expect(plain(l)).toContain(s.t); expect(plain(hw)).toContain(s.t); expect(plain(l)).toContain(s.b); }
    expect(hrefs(l)).toContain("/how-it-works");
    expect(hrefs(l)).toContain("/privacy");
  });
  it("uses a sensible heading outline: one h1, steps one level below their section", async () => {
    const l = await landing();
    expect(count(l, "<h1")).toBe(1);
    expect(l).toMatch(/<h2[^>]*>How it works<\/h2>/);
    for (const s of HOW_IT_WORKS_STEPS) expect(l).toContain(`>${s.t}</h3>`);
    expect(await how()).toContain(`>${HOW_IT_WORKS_STEPS[0].t}</h2>`);
  });
  it("says what is saved and what needs which plan, from the plan config", async () => {
    const t = plain(await landing());
    expect(t).toContain("Save snapshots to your History on every plan. Recording a clip to download is included in Pro and Lifetime.");
  });
  it("describes credits as session time from Go live, not 'only while the magic is on'", async () => {
    const t = plain(await landing());
    expect(t).toContain("Counted from when you press Go live until the session ends");
  });
  for (const [name, render] of [["landing", landing], ["how-it-works", how], ["pricing", pricing]] as const) {
    it(`${name} keeps none of the removed claims`, async () => {
      const t = plain(await render());
      for (const re of REMOVED_CLAIMS) expect(t, String(re)).not.toMatch(re);
    });
  }
  it("faq and metadata keep none of them either", () => {
    const t = plain(faq());
    for (const re of REMOVED_CLAIMS) expect(t, String(re)).not.toMatch(re);
    const layout = readFileSync("app/layout.tsx", "utf8");
    expect(layout).not.toMatch(/anyone, anything, anywhere/);
  });
});

describe("where the studio buttons go", () => {
  it("signed out: every main button goes to sign-up, nothing links straight to the studio", async () => {
    for (const render of [landing, how]) {
      const s = await render();
      expect(hrefs(s)).toContain("/sign-up");
      expect(hrefs(s)).not.toContain("/studio");
      expect(plain(s)).not.toContain("Open the studio");
    }
    expect(plain(await landing())).toContain("Sign up to open the studio");
    expect(plain(await landing())).toContain("Try it free");
  });
  it("signed in: the buttons say 'Open the studio' and go to /studio, and the sign-up pitch is gone", async () => {
    h.me = "user_1";
    for (const render of [landing, how]) {
      const s = await render();
      expect(hrefs(s)).toContain("/studio");
      expect(hrefs(s)).not.toContain("/sign-up");
      expect(plain(s)).toContain("Open the studio");
      expect(plain(s)).not.toContain("Try it free");
    }
    expect(plain(await landing())).not.toContain("free credits every month");
  });
  it("without Clerk configured the pages still render, signed out, and Clerk is never called", async () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; delete process.env.CLERK_SECRET_KEY;
    expect(await viewerId()).toBeNull();
    const l = await landing();
    expect(hrefs(l)).toContain("/sign-up");
    expect((await how())).toContain("/sign-up");
    expect(h.authCalls).toBe(0);
  });
  it("viewerId returns the user id when signed in and null when not", async () => {
    expect(await viewerId()).toBeNull();
    h.me = "user_9";
    expect(await viewerId()).toBe("user_9");
  });
});

describe("the pricing page", () => {
  it("replaces 'Popular' with a neutral label and describes camera capture, not 'resolution'", async () => {
    const p = plain(await pricing());
    expect(p).toContain("Subscription");
    expect(p).toContain("Camera captured at up to 640×360");
    expect(p).toContain("Camera captured at up to 1280×720");
    expect(p).not.toMatch(/popular|high resolution|standard resolution/i);
  });
  it("lists the billing details, with the yearly price when one is set", async () => {
    const p = plain(await pricing());
    expect(p).toContain("Billing details");
    for (const term of ["Renewal", "Cancelling", "Currency", "Payment methods", "Top-ups", "Refunds"]) expect(p).toContain(term);
    expect(p).toMatch(/yearly subscription for/);
    expect(p).toContain("non-refundable except where the law requires otherwise");
    expect(hrefs(await pricing())).toEqual(expect.arrayContaining(["/terms", "/contact"]));
  });
  it("does not mention a yearly option when it has no price", async () => {
    delete process.env.PRICE_PRO_YEARLY;
    expect(plain(await pricing())).not.toMatch(/yearly/i);
  });
  it("still shows the 'prices are not final' notice until the owner approves them, and only once", async () => {
    const before = await pricing();
    expect(count(before, 'role="note"')).toBe(1);
    expect(plain(before)).toContain("Pricing is not final");
    process.env.PRICING_APPROVED = "true";
    expect(count(await pricing(), 'role="note"')).toBe(0);
  });
  it("keeps the plan names as headings", async () => {
    const p = await pricing();
    for (const n of ["Free", "Pro", "Lifetime"]) expect(p).toContain(`>${n}</h3>`);
  });
});

describe("the FAQ", () => {
  it("answers where the video goes, whether audio is used, and which payment method covers what", () => {
    const t = plain(faq());
    expect(t).toContain("Where does my video go?");
    expect(t).toMatch(/sent to a third-party AI service/);
    expect(t).toContain("Is audio used?");
    expect(t).toMatch(/video only/i);
    expect(t).toMatch(/Pro subscriptions are paid through Paystack/);
    expect(t).toMatch(/Lifetime and top-ups can be paid through Paystack or with cryptocurrency/);
  });
  it("keeps the structured data in step with the visible answers", () => {
    const s = html(Faq() as ReactElement);
    const ld = JSON.parse(s.match(/<script type="application\/ld\+json">(.*?)<\/script>/)![1].replace(/&quot;/g, '"'));
    expect(ld.mainEntity.map((q: { name: string }) => q.name)).toContain("Is audio used?");
  });
});
