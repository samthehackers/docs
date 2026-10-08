import { expect, test, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "small-phone", width: 320, height: 640 },
  { name: "mobile", width: 360, height: 740 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
];
const PUBLIC_PAGES = ["/", "/pricing", "/how-it-works", "/faq", "/terms", "/privacy", "/contact", "/sign-in", "/sign-up"];

async function overflowPx(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} ${vp.width}px`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    for (const path of PUBLIC_PAGES) {
      test(`${path} renders, fits the screen and is accessible`, async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
        page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
        // Console messages for failed loads don't name the URL, so record failed responses too.
        page.on("response", (r) => { if (r.status() >= 400 && r.url() !== page.url()) errors.push(`${r.status()} ${new URL(r.url()).pathname}`); });

        const res = await page.goto(path);
        expect(res?.status(), "status").toBe(200);

        // Responsive: no horizontal scrolling
        expect(await overflowPx(page), "horizontal overflow (px)").toBeLessThanOrEqual(0);

        // Basic accessibility
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        expect((await page.title()).length, "title").toBeGreaterThan(0);
        await expect(page.locator("main")).toHaveCount(1);
        await expect(page.locator("h1, p.gradient-text").first()).toBeVisible();
        if (path !== "/sign-in" && path !== "/sign-up") await expect(page.locator("h1")).toHaveCount(1);
        const unlabelled = await page.evaluate(() => [...document.querySelectorAll("button, a")].filter((el) => !(el.textContent ?? "").trim() && !el.getAttribute("aria-label") && !el.querySelector("img[alt]")).length);
        expect(unlabelled, "buttons/links with no accessible name").toBe(0);

        expect(errors, "browser errors").toEqual([]);
        await page.screenshot({ path: `test-results/shots/${vp.name}${path === "/" ? "-home" : path.replace(/\//g, "-")}.png`, fullPage: true });
      });
    }

    test("pricing: plans are readable and the 'not final' notice shows", async ({ page }) => {
      await page.goto("/pricing");
      await expect(page.getByRole("note")).toContainText("Pricing is not final");
      for (const name of ["Free", "Pro", "Lifetime"]) await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
      expect(await overflowPx(page)).toBeLessThanOrEqual(0);
    });

    test("navigation is reachable at this width", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: "AltrCam home" })).toBeVisible();
      await expect(page.getByRole("link", { name: /pricing/i }).first()).toBeVisible();
    });
  });
}

test.describe("content honesty", () => {
  test("landing page names the product, keeps the tagline and the model attribution small and in the footer", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Be anyone.");
    await expect(page.locator("footer")).toContainText("Powered by Lucy 2.5 from Decart");
    await expect(page.locator("main")).not.toContainText("Decart");
    await expect(page.locator("main")).not.toContainText(/testimonial|trusted by|\d+\+? (users|customers)/i);
  });
  test("terms and privacy are clearly marked as templates", async ({ page }) => {
    for (const p of ["/terms", "/privacy"]) {
      await page.goto(p);
      await expect(page.locator("main")).toContainText("Template text");
    }
  });
});

test.describe("without credentials the app fails honestly, not randomly", () => {
  for (const path of ["/dashboard", "/studio", "/history", "/presets", "/billing", "/settings", "/support", "/admin"]) {
    test(`${path} is not served and says why`, async ({ request }) => {
      const res = await request.get(path);
      expect(res.status()).toBe(503);
      expect(await res.text()).toContain("not configured");
    });
  }
  test("protected APIs refuse (503 here; 401 when signed-out with Clerk configured)", async ({ request }) => {
    for (const path of ["/api/studio/session/start", "/api/payments/checkout", "/api/admin/credits"]) {
      expect((await request.post(path, { data: {} })).status()).toBe(503);
    }
  });
  test("webhooks reject unsigned requests", async ({ request }) => {
    for (const w of ["paystack", "nowpayments", "clerk"]) expect((await request.post(`/api/webhooks/${w}`, { data: "{}" })).status()).toBe(401);
  });
  test("unknown URLs get the branded 404; look-alike auth paths are not public", async ({ page, request }) => {
    const res = await page.goto("/definitely-not-a-page");
    expect(res?.status()).toBe(404);
    await expect(page.getByText("That page doesn't exist")).toBeVisible();
    expect((await request.get("/sign-inn")).status()).toBe(404);
  });
  test("health reports nothing configured and leaks no values", async ({ request }) => {
    const body = await (await request.get("/api/health")).json();
    expect(body.status).toBe("ok");
    expect(Object.values(body.capabilities).every((v) => v === false)).toBe(true);
  });
});

test.describe("security headers", () => {
  test("every page carries CSP, framing, sniffing and transport protections", async ({ request }) => {
    const h = (await request.get("/")).headers();
    expect(h["content-security-policy"]).toContain("default-src 'self'");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["strict-transport-security"]).toContain("max-age=");
    expect(h["referrer-policy"]).toBeTruthy();
    expect(h["permissions-policy"]).toContain("camera=(self)");
    expect(h["x-powered-by"]).toBeUndefined();
  });
});
