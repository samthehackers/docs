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

const h = vi.hoisted(() => ({ me: null as string | null, authCalls: 0, authThrows: false as boolean | Error, plans: null as null | Record<string, unknown> }));
// The Clerk widgets are stubbed so the sign-in and sign-up pages can be rendered here.
vi.mock("@clerk/nextjs", () => ({
  SignUp: () => "CLERK_SIGNUP_FORM", SignIn: () => "CLERK_SIGNIN_FORM",
  useUser: () => ({ isLoaded: false, user: undefined }), useClerk: () => ({ signOut: async () => {} }), // the account menu, for signed-in visitors
}));
vi.mock("@clerk/nextjs/server", () => ({ auth: async () => { h.authCalls++; if (h.authThrows) throw h.authThrows instanceof Error ? h.authThrows : new Error("clerk down"); return { userId: h.me }; } }));
// Plan limits come from the database in production; a test can hand the pages a specific set instead.
vi.mock("@/lib/plan-config", async (orig) => {
  const real = await orig<typeof import("@/lib/plan-config")>();
  return { ...real, getPlans: async (...a: Parameters<typeof real.getPlans>) => (h.plans as Awaited<ReturnType<typeof real.getPlans>> | null) ?? real.getPlans(...a) };
});

import Landing from "@/app/(marketing)/page";
import HowItWorks from "@/app/(marketing)/how-it-works/page";
import Pricing from "@/app/(marketing)/pricing/page";
import Faq from "@/app/(marketing)/faq/page";
import MarketingLayout from "@/app/(marketing)/layout";
import Privacy from "@/app/(marketing)/privacy/page";
import SignUpPage from "@/app/(auth)/sign-up/[[...sign-up]]/page";
import SignInPage from "@/app/(auth)/sign-in/[[...sign-in]]/page";
import { StudioCta } from "@/components/studio-cta";
import { DEFAULT_PLANS } from "@/lib/plans";
import { PAYMENT_METHODS_TEXT, SIGNUP_CLOSED } from "@/lib/public-copy";
import { HOW_IT_WORKS_STEPS } from "@/components/how-it-works-steps";
import { LIVE_AVAILABILITY } from "@/lib/availability";
import { viewerId } from "@/lib/viewer";

beforeAll(() => { (globalThis as { React?: unknown }).React = React; }); // pages are JSX; Next compiles them with the automatic runtime
const ENV = { ...process.env };
beforeEach(() => {
  h.me = null; h.authCalls = 0; h.authThrows = false;
  h.plans = structuredClone(DEFAULT_PLANS); // the pages get these limits; no database is touched
  process.env.DATABASE_URL = "postgres://unused/ignored"; // "accounts are open" needs a database to be configured
  process.env.SIGNUPS_OPEN = "true"; // ...and the owner's sign-up switch
  process.env.PAYSTACK_SECRET_KEY = "sk_test_x"; // "checkout is open" needs a payment provider
  process.env.CRON_SECRET = "cron_x"; // the monthly refill needs it, so "every month" can be promised
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
const layout = async () => html((await MarketingLayout({ children: null })) as ReactElement);

const REMOVED_CLAIMS = [
  /your face, their look/i, /post it anywhere/i, /no waiting/i, /magic/i, /instantly/i, /\bpopular\b/i,
  /anyone, anywhere/i, /high resolution/i, /standard resolution/i, /testimonial|trusted by/i,
  /free forever|yours forever|pay per second|pay by the second/i,
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
  it("without Clerk configured the pages still render, signed out, offer no sign-up button, and Clerk is never called", async () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; delete process.env.CLERK_SECRET_KEY;
    expect(await viewerId()).toBeNull();
    for (const render of [landing, how]) {
      const s = await render();
      expect(hrefs(s)).not.toContain("/sign-up");
      expect(plain(s)).toContain("Sign-up isn't open on this deployment yet.");
      expect(plain(s)).not.toMatch(/Try it free|Sign up to open the studio/);
    }
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
    expect(p).toContain("Camera feed requested at 640×360");
    expect(p).toContain("Camera feed requested at 1280×720");
    expect(p).not.toMatch(/captured at up to/);
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
    expect(count(plain(before), "Pricing is not final")).toBe(1);
    expect(plain(before)).toContain("These amounts are not final yet.");
    process.env.PRICING_APPROVED = "true";
    const after = plain(await pricing());
    expect(after).not.toContain("Pricing is not final");
    expect(after).not.toMatch(/not final yet|pricing notice/i); // no sentence may point at a notice that is gone
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

describe("review follow-ups: the pages that ask for money, and sentences tied to the code", () => {
  it("/pricing carries the live-video status, because it is the page that asks for money; the pricing notice is still there once", async () => {
    const p = await pricing();
    expect(p).toContain('data-testid="live-availability"');
    expect(plain(p)).toContain(LIVE_AVAILABILITY.body);
    expect(count(plain(p), "Pricing is not final")).toBe(1);
  });
  it("/billing and the FAQ carry it too", () => {
    expect(readFileSync("app/(app)/billing/page.tsx", "utf8")).toContain("<AvailabilityNotice />");
    expect(html(Faq() as ReactElement)).toContain('data-testid="live-availability"');
  });
  it("the FAQ says clips are downloaded to the device and not stored, and snapshots are saved", () => {
    const t = plain(faq());
    expect(t).toMatch(/Clips, on plans that include recording, are downloaded to your own device; AltrCam does not store them/);
    expect(t).toMatch(/Snapshots are saved to your History/);
    expect(t).not.toMatch(/clips[^.]*are saved/i);
    expect(t).toMatch(/AltrCam does not record your live video/);
    expect(t).toMatch(/reference image you attach is uploaded to AltrCam's storage/);
  });
  it("Privacy and Terms agree with the pages: clips are not stored, a credit is session time from Go live", () => {
    expect(readFileSync("app/(marketing)/privacy/page.tsx", "utf8")).toMatch(/clips you record are downloaded to your own device and are not stored by us/);
    expect(readFileSync("app/(marketing)/terms/page.tsx", "utf8")).toMatch(/1 second of session time, counted from when you press Go live/);
    expect(readFileSync("app/(marketing)/terms/page.tsx", "utf8")).not.toMatch(/1 second of live video/);
  });
  it("the FAQ payment answer is the same text as the billing details", () => {
    expect(plain(faq())).toContain(PAYMENT_METHODS_TEXT);
  });
  it("the FAQ links to contact us, and the pricing buttons go to billing and sign-up", async () => {
    expect(hrefs(faq())).toContain("/contact");
    const h2 = hrefs(await pricing());
    expect(h2).toContain("/billing");
    expect(h2).toContain("/sign-up");
  });
  it("steps 3 and 4 state what is billed and when, and where the video goes", () => {
    const step = (n: number) => HOW_IT_WORKS_STEPS[n - 1].b;
    expect(step(3)).toMatch(/sent to a third-party realtime AI model/);
    expect(step(4)).toMatch(/counted from when you press Go live until it ends/);
    expect(step(1)).toMatch(/video only, never your microphone/);
  });
  it("shows the free-credit line to a signed-out visitor, from the plan config", async () => {
    expect(plain(await landing())).toContain("300 free credits every month. No card needed.");
    h.plans = { ...DEFAULT_PLANS, FREE: { ...DEFAULT_PLANS.FREE, monthlyCredits: 450 } };
    expect(plain(await landing())).toContain("450 free credits every month.");
  });
  it("the saving sentence on the landing page follows the admin's plan config", async () => {
    h.plans = { ...DEFAULT_PLANS, LIFETIME: { ...DEFAULT_PLANS.LIFETIME, clipRecording: false } };
    const t = plain(await landing());
    expect(t).toContain("Recording a clip to download is included in Pro.");
    expect(t).not.toContain("Pro and Lifetime");
  });
  it("prices are shown in the configured currency", async () => {
    process.env.PRICE_CURRENCY = "USD";
    const t = plain(await pricing());
    expect(t).toContain("charged in USD");
    expect(t).not.toMatch(/charged in NGN/);
  });
  it("the page headline and the first step no longer sell 'pay per second' for what is a monthly plan with an allowance", async () => {
    const t = plain(await pricing());
    expect(t).toContain("Credits by the second.");
    expect(HOW_IT_WORKS_STEPS[3].t).toBe("4. Credits by the second");
  });
  it("the marketing header shows Dashboard when signed in and Get started when not (the layout is rendered here)", async () => {
    expect(plain(await layout())).toContain("Get started");
    expect(plain(await layout())).not.toContain("Dashboard");
    h.me = "user_1";
    expect(plain(await layout())).toContain("Dashboard");
    expect(plain(await layout())).not.toContain("Get started");
  });
  it("a Clerk failure reads as signed out instead of taking the public pages down", async () => {
    h.authThrows = true;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await viewerId()).toBeNull();
    expect(hrefs(await landing())).toContain("/sign-up");
    expect(plain(await layout())).toContain("Get started");
    err.mockRestore();
  });
  it("Next's own signals pass through viewerId (static-to-dynamic bailout, redirects) instead of being swallowed as 'signed out'", async () => {
    h.authThrows = Object.assign(new Error("Dynamic server usage: headers"), { digest: "DYNAMIC_SERVER_USAGE" });
    await expect(viewerId()).rejects.toMatchObject({ digest: "DYNAMIC_SERVER_USAGE" });
    h.authThrows = Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/sign-in;307;" });
    await expect(viewerId()).rejects.toMatchObject({ digest: expect.stringContaining("NEXT_REDIRECT") });
  });
  it("the sizes the pricing cards describe are the ones the Studio requests: it uses CAPTURE_SIZE, not its own copy", () => {
    const studio = readFileSync("components/studio/studio.tsx", "utf8");
    expect(studio).toMatch(/CAPTURE_SIZE\[p\.resolution\]/);
    expect(studio).not.toMatch(/width:\s*(640|1280)/);
  });
  it("the 'no audio' copy is tied to the code: the camera is opened with audio switched off and nothing else asks for a microphone", () => {
    const cam = readFileSync("lib/studio-camera.ts", "utf8");
    expect(cam).toMatch(/audio:\s*false/);
    expect(cam).not.toMatch(/audio:\s*true/);
    expect(readFileSync("components/studio/studio.tsx", "utf8")).not.toMatch(/audio:\s*true/);
  });
  it("the meta description is hedged and says live video is untested", () => {
    const l = readFileSync("app/layout.tsx", "utf8");
    expect(l).toMatch(/is built to restyle/);
    expect(l).toMatch(/Live video has not been tested end to end yet/);
  });
  it("the landing hero is hedged: built to, meant to appear, not 'watch the result'", async () => {
    const t = plain(await landing());
    expect(t).toMatch(/is built to restyle/);
    expect(t).toMatch(/is meant to appear in the studio/);
    expect(t).not.toMatch(/watch the result/);
  });
  it("the three value props are top-level headings, not children of 'How it works'", async () => {
    const l = await landing();
    for (const t of ["1 credit = 1 second", "Your camera, your call", "Keep what you make"]) expect(l).toContain(`>${t}</h2>`);
  });
});

describe("what the pages promise when accounts are not open (the live deployment had no Clerk keys and no database)", () => {
  it("the shared live-video note no longer says visitors can create an account", () => {
    expect(`${LIVE_AVAILABILITY.title} ${LIVE_AVAILABILITY.body}`).not.toMatch(/create an account|look around/i);
    expect(LIVE_AVAILABILITY.body).toMatch(/even if the connection fails/);
  });
  it("without a database the landing page says sign-up isn't open instead of promising free credits", async () => {
    delete process.env.DATABASE_URL;
    const t = plain(await landing());
    expect(t).toContain("Sign-up isn't open on this deployment yet.");
    expect(t).not.toMatch(/free credits every month/);
    expect(t).not.toMatch(/create an account/i);
  });
  it("without Clerk keys it says the same", async () => {
    delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; delete process.env.CLERK_SECRET_KEY;
    const t = plain(await landing());
    expect(t).toContain("Sign-up isn't open on this deployment yet.");
    expect(t).not.toMatch(/free credits every month/);
  });
  it("with Clerk and a database it promises the free credits, from the plan config", async () => {
    const t = plain(await landing());
    expect(t).toContain("300 free credits every month. No card needed.");
    expect(t).not.toContain("Sign-up isn't open");
  });
  it("a signed-in visitor sees neither line", async () => {
    h.me = "user_1";
    const t = plain(await landing());
    expect(t).not.toContain("Sign-up isn't open");
    expect(t).not.toContain("free credits every month");
  });
  it("no capability is stated unhedged next to the 'untested' note", async () => {
    const t = plain(await landing());
    expect(t).toContain("The AI tries to restyle your live video to match.");
    expect(t).not.toMatch(/The AI restyles your live video/);
  });
  it("the pricing buttons name the plan properly", async () => {
    const t = plain(await pricing());
    expect(t).toContain("Choose Pro");
    expect(t).toContain("Choose Lifetime");
    expect(t).not.toMatch(/Choose pro|Choose lifetime/);
  });
  it("Privacy and the support page say AltrCam does not record video, the same as the FAQ", () => {
    const privacy = plain(html(Privacy() as ReactElement));
    expect(privacy).toMatch(/AltrCam's servers do not record or store it\. What our AI provider does with video it receives is governed by its own terms/);
    expect(privacy).not.toMatch(/not recorded by default/);
    expect(readFileSync("components/troubleshooting.tsx", "utf8")).toMatch(/AltrCam's servers do not record or store live video/);
    expect(readFileSync("components/troubleshooting.tsx", "utf8")).not.toMatch(/not recorded by default/);
  });
});

describe("the sign-in and sign-up pages", () => {
  const signUp = async () => html((await SignUpPage()) as ReactElement);
  const signIn = async () => html((await SignInPage()) as ReactElement);
  it("sign-up: the agreement line sits under the form and links the Terms and the acceptable-use section", async () => {
    const s = await signUp();
    expect(plain(s)).toMatch(/By creating an account you agree to the Terms and Acceptable Use Policy ?\./);
    expect(s.indexOf("By creating an account")).toBeGreaterThan(s.indexOf("CLERK_SIGNUP_FORM"));
    expect(hrefs(s)).toEqual(expect.arrayContaining(["/terms", "/terms#acceptable-use", "/privacy", "/"]));
    expect(s).toMatch(/<a[^>]*href="\/"[^>]*>Back to home<\/a>/);
  });
  it("the Terms really have the acceptable-use anchor the link points at", () => {
    expect(readFileSync("app/(marketing)/terms/page.tsx", "utf8")).toMatch(/<h2 id="acceptable-use"[^>]*>2\. Acceptable use<\/h2>/);
  });
  it("sign-in: a Privacy link and Back to home, and no agreement line (nobody is creating an account there)", async () => {
    const s = await signIn();
    expect(hrefs(s)).toEqual(expect.arrayContaining(["/privacy", "/"]));
    expect(plain(s)).not.toContain("By creating an account");
  });
  it("both have exactly one h1, visually hidden, open or closed", async () => {
    for (const closed of [false, true]) {
      if (closed) delete process.env.DATABASE_URL;
      const up = await signUp(), inn = await signIn();
      expect(count(up, "<h1")).toBe(1); expect(count(inn, "<h1")).toBe(1);
      expect(up).toMatch(/<h1 class="sr-only">Create your account<\/h1>/);
      expect(inn).toMatch(/<h1 class="sr-only">Sign in<\/h1>/);
      expect(up).toContain('<main id="content"');
    }
  });
  it("closed: no agreement line, because there is no form to agree under", async () => {
    delete process.env.SIGNUPS_OPEN;
    const s = await signUp();
    expect(plain(s)).not.toContain("CLERK_SIGNUP_FORM");
    expect(plain(s)).not.toContain("By creating an account");
    expect(hrefs(s)).toContain("/privacy");
  });
});

describe("one answer to 'is sign-up open', everywhere (review of the account-claim fix)", () => {
  // Every combination of the three things sign-up needs: both Clerk keys, the database, and the owner's switch (SIGNUPS_OPEN).
  const ENVS = [false, true].flatMap((clerk) => [false, true].flatMap((db) => [false, true].map((flag) => ({
    clerk, db, flag, name: `${clerk ? "Clerk" : "no Clerk"}, ${db ? "database" : "no database"}, SIGNUPS_OPEN ${flag ? "true" : "unset"}`,
  }))));
  const setEnv = (e: { clerk: boolean; db: boolean; flag: boolean }) => {
    if (!e.clerk) { delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY; delete process.env.CLERK_SECRET_KEY; }
    if (!e.db) delete process.env.DATABASE_URL;
    if (!e.flag) delete process.env.SIGNUPS_OPEN;
  };
  for (const e of ENVS) {
    it(`${e.name}: the landing page, how-it-works, pricing, header and both auth pages all agree`, async () => {
      setEnv(e);
      const open = e.clerk && e.db && e.flag, canSignIn = e.clerk && e.db;
      const l = await landing(), hw = await how(), pr = await pricing(), hd = await layout();
      const su = html((await SignUpPage()) as ReactElement), si = html((await SignInPage()) as ReactElement);
      if (open) {
        expect(plain(su)).toContain("CLERK_SIGNUP_FORM");
        expect(hrefs(l)).toContain("/sign-up"); expect(hrefs(hw)).toContain("/sign-up");
        expect(plain(hd)).toContain("Get started"); expect(plain(hd)).toContain("Sign in");
        expect(plain(pr)).toContain("Start free");
        for (const s of [l, hw]) expect(plain(s)).not.toContain(SIGNUP_CLOSED);
      } else {
        expect(plain(su)).not.toContain("CLERK_SIGNUP_FORM");
        expect(plain(su)).toContain("Accounts aren't available on this deployment yet");
        for (const s of [l, hw]) { expect(hrefs(s)).not.toContain("/sign-up"); expect(plain(s)).toContain(SIGNUP_CLOSED); }
        expect(hrefs(hd)).not.toContain("/sign-up");
        expect(plain(hd)).not.toMatch(/Get started/);
        expect(plain(pr)).toContain("Sign-up isn't open yet");
        expect(plain(pr)).not.toContain("Start free");
      }
      // Sign-in needs only the credentials: switching sign-up off must not lock existing accounts out.
      if (canSignIn) {
        expect(plain(si)).toContain("CLERK_SIGNIN_FORM");
        expect(hrefs(hd)).toContain("/sign-in");
      } else {
        expect(plain(si)).not.toContain("CLERK_SIGNIN_FORM");
        expect(plain(si)).toContain("Accounts aren't available on this deployment yet");
        expect(hrefs(hd)).not.toContain("/sign-in");
        expect(plain(hd)).not.toMatch(/Sign in/);
      }
    });
  }
  it("partial Clerk configuration (one key) counts as not configured, on the landing page and the auth pages", async () => {
    delete process.env.CLERK_SECRET_KEY;
    expect(plain(await landing())).toContain("Sign-up isn't open on this deployment yet.");
    expect(plain(html((await SignUpPage()) as ReactElement))).toContain("Accounts aren't available");
    process.env.CLERK_SECRET_KEY = "sk_test_x"; delete process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
    expect(plain(await landing())).toContain("Sign-up isn't open on this deployment yet.");
  });
  it("the closed notices are announced as status messages", async () => {
    delete process.env.DATABASE_URL;
    expect(await landing()).toMatch(/<p role="status"[^>]*>Sign-up isn&#x27;t open on this deployment yet\.<\/p>/);
    expect(await how()).toMatch(/<p role="status"[^>]*>Sign-up isn&#x27;t open on this deployment yet\.<\/p>/);
  });
  it("StudioCta: a signed-out visitor gets no button when accounts are closed; a signed-in one always gets the studio", () => {
    expect(StudioCta({ signedIn: false, accountsOpen: false })).toBeNull();
    expect(hrefs(html(StudioCta({ signedIn: true, accountsOpen: false }) as ReactElement))).toEqual(["/studio"]);
    expect(hrefs(html(StudioCta({ signedIn: false, accountsOpen: true }) as ReactElement))).toEqual(["/sign-up"]);
  });
  it("pricing: with accounts open but no payment provider, checkout buttons are replaced and the page says so", async () => {
    delete process.env.PAYSTACK_SECRET_KEY;
    const t = plain(await pricing());
    expect(t).toContain("Checkout isn't open on this deployment yet.");
    expect(t).toContain("Start free");
    expect(t).not.toMatch(/Choose Pro|Choose Lifetime/);
    expect(count(t, "Not available yet")).toBe(5); // Pro, Lifetime and three top-ups
  });
  it("pricing: with a payment provider the buttons are there and no checkout notice shows", async () => {
    const t = plain(await pricing());
    expect(t).toContain("Choose Pro");
    expect(t).not.toContain("Checkout isn't open");
    process.env.NOWPAYMENTS_API_KEY = "k"; delete process.env.PAYSTACK_SECRET_KEY;
    expect(plain(await pricing())).toContain("Checkout isn't open"); // NOWPayments needs its IPN secret too
    process.env.NOWPAYMENTS_IPN_SECRET = "s";
    expect(plain(await pricing())).toContain("Choose Lifetime");
  });
  it("the pricing button names follow the plan's label, not a hard-coded word", async () => {
    h.plans = { ...DEFAULT_PLANS, PRO: { ...DEFAULT_PLANS.PRO, label: "Plus" } };
    expect(plain(await pricing())).toContain("Choose Plus");
  });
  it("free credits: 'every month' only when the refill job can run; nothing at all when the Free plan grants none", async () => {
    expect(plain(await landing())).toContain("300 free credits every month. No card needed.");
    delete process.env.CRON_SECRET;
    const noCron = plain(await landing());
    expect(noCron).toContain("300 free credits when you sign up. No card needed.");
    expect(noCron).not.toContain("every month. No card");
    h.plans = { ...DEFAULT_PLANS, FREE: { ...DEFAULT_PLANS.FREE, monthlyCredits: 0 } };
    process.env.CRON_SECRET = "cron_x";
    const zero = plain(await landing());
    expect(zero).not.toMatch(/free credits/);
    expect(zero).not.toMatch(/\b0 free/);
  });
  it("the old sentence promising an account is gone from every page that carried it (it was on five)", async () => {
    const pages = [await landing(), await how(), await pricing(), html(Faq() as ReactElement)];
    for (const p of pages) expect(plain(p)).not.toMatch(/create an account|look around/i);
    expect(readFileSync("app/(app)/billing/page.tsx", "utf8")).not.toMatch(/create an account|look around/i);
    expect(readFileSync("lib/availability.ts", "utf8")).not.toMatch(/create an account|look around/i);
  });
  it("with no credentials at all the pages render using the real plan fallback", async () => {
    h.plans = null;
    for (const k of ["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "DATABASE_URL", "PAYSTACK_SECRET_KEY", "CRON_SECRET"]) delete process.env[k];
    const l = plain(await landing());
    expect(l).toContain("Be anyone.");
    expect(plain(await pricing())).toContain("Camera feed requested at 640×360"); // the default Free plan, from the code defaults
    expect(h.authCalls).toBe(0);
  });
});
