/**
 * Realtime smoke test: drives /admin/diagnostics on a deployed AltrCam in headless Chromium, waits for the check to
 * finish, prints the report as JSON and exits 0 on PASS, 1 on anything else. See docs/REALTIME_VERIFICATION.md.
 *
 *   SMOKE_BASE_URL=https://<preview> SMOKE_ADMIN_EMAIL=you@example.com \
 *     npx tsx --env-file=.env.local scripts/smoke-realtime.ts
 *
 * Sign-in, first one configured wins:
 *  1. Clerk's testing helpers (@clerk/testing, a devDependency): SMOKE_ADMIN_EMAIL, plus CLERK_SECRET_KEY and
 *     NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (or CLERK_PUBLISHABLE_KEY) of the TARGET deployment's Clerk instance. Signs in
 *     with a one-time sign-in token from Clerk's backend API, or with SMOKE_ADMIN_PASSWORD (password strategy) when set.
 *     Clerk testing tokens are meant for development instances; for a production instance use 2 or 3.
 *  2. SMOKE_STORAGE_STATE: path to a Playwright storage state of a signed-in admin
 *     (`npx playwright codegen --save-storage=admin.json https://<preview>/sign-in`, sign in, close the window).
 *  3. SMOKE_SESSION_COOKIE: a Cookie header value for the target host, e.g. "__session=...; __client_uat=...".
 *     Clerk's __session lasts about a minute, so copy it fresh; prefer 2.
 * Secrets (the cookie, the storage state, CLERK_SECRET_KEY, SMOKE_ADMIN_PASSWORD) are never printed.
 *
 * Other settings: PW_CHROMIUM_PATH (a Chromium binary, when Playwright's bundled one is not installed),
 * SMOKE_TIMEOUT_MS (how long to wait for the check to finish once started; default 120000; also caps the 30 s wait for
 * the page's button).
 *
 * PASS is decided HERE, not taken from the page: the page must report "pass" AND the numbers it reports must meet
 * PASS_CRITERIA (lib/diagnostics/criteria.ts, the same rule the page applies). A page that claims PASS with numbers
 * that do not meet the rule is a FAIL.
 */
import { readFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { evaluate, FIRST_FRAME_WAIT_MS, PASS_CRITERIA, redact, type DiagnosticsReport } from "../lib/diagnostics/criteria";

const PAGE_PATH = "/admin/diagnostics";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_LOG_LINES = 30;

type SignIn = "clerk-testing" | "storage-state" | "session-cookie";
interface Smoke {
  tool: "altrcam-smoke-realtime";
  baseUrl: string | null;
  page: string;
  signIn: SignIn | null;
  pass: boolean;
  /** The script's own verdict (PASS_CRITERIA applied to the page's numbers). */
  verdict: string;
  /** What the page itself said. */
  pageVerdict: string | null;
  criteria: typeof PASS_CRITERIA;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  warnings: string[];
  /** Browser console errors and failed same-site requests during the run, redacted. */
  browserLog: string[];
}

const env = (k: string) => { const v = process.env[k]?.trim(); return v ? v : undefined; };

/** Every secret value this run was given, so nothing printed can contain one even if a page echoed it. */
function secrets(): string[] {
  const out: string[] = [];
  for (const k of ["CLERK_SECRET_KEY", "SMOKE_ADMIN_PASSWORD", "CLERK_TESTING_TOKEN"]) { const v = env(k); if (v) out.push(v); }
  const cookie = env("SMOKE_SESSION_COOKIE");
  if (cookie) { out.push(cookie); for (const c of parseCookieHeader(cookie)) if (c.value.length >= 6) out.push(c.value); }
  const state = env("SMOKE_STORAGE_STATE");
  if (state) {
    try {
      const s = JSON.parse(readFileSync(state, "utf8")) as { cookies?: { value?: string }[] };
      for (const c of s.cookies ?? []) if (c.value && c.value.length >= 6) out.push(c.value);
    } catch { /* reported when it is used */ }
  }
  return out.sort((a, b) => b.length - a.length);
}
const SECRETS = secrets();
function scrub(text: string): string {
  let t = redact(text);
  for (const s of SECRETS) t = t.split(s).join("[redacted]");
  return t;
}

function parseCookieHeader(header: string): { name: string; value: string }[] {
  return header.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf("=");
    return i > 0 ? { name: p.slice(0, i).trim(), value: p.slice(i + 1).trim() } : null;
  }).filter((c): c is { name: string; value: string } => !!c && !!c.name);
}

function chooseSignIn(): SignIn | null {
  if (env("SMOKE_ADMIN_EMAIL")) return "clerk-testing";
  if (env("SMOKE_STORAGE_STATE")) return "storage-state";
  if (env("SMOKE_SESSION_COOKIE")) return "session-cookie";
  return null;
}

class SmokeError extends Error {}

async function signInWithClerk(page: Page, base: string) {
  const email = env("SMOKE_ADMIN_EMAIL")!;
  let mod: typeof import("@clerk/testing/playwright");
  try { mod = await import("@clerk/testing/playwright"); } catch (e) { throw new SmokeError(`@clerk/testing is not installed: ${(e as Error).message}`); }
  // Only the environment this script was given (no .env.local auto-loading: it may belong to another deployment).
  try { await mod.clerkSetup({ dotenv: false }); } catch (e) { throw new SmokeError(`Clerk testing setup failed: ${(e as Error).message}`); }
  await page.goto(`${base}/sign-in`, { waitUntil: "domcontentloaded" });
  const password = env("SMOKE_ADMIN_PASSWORD");
  try {
    if (password) await mod.clerk.signIn({ page, signInParams: { strategy: "password", identifier: email, password } });
    else await mod.clerk.signIn({ page, emailAddress: email });
  } catch (e) { throw new SmokeError(`Clerk sign-in failed: ${(e as Error).message}`); }
}

async function newContext(browser: Browser, how: SignIn, base: string): Promise<BrowserContext> {
  if (how === "storage-state") {
    const path = env("SMOKE_STORAGE_STATE")!;
    try { JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new SmokeError(`SMOKE_STORAGE_STATE is not a readable JSON file: ${(e as Error).message}`); }
    return browser.newContext({ storageState: path });
  }
  const ctx = await browser.newContext();
  if (how === "session-cookie") {
    const cookies = parseCookieHeader(env("SMOKE_SESSION_COOKIE")!);
    if (!cookies.length) throw new SmokeError("SMOKE_SESSION_COOKIE has no name=value pairs");
    await ctx.addCookies(cookies.map((c) => ({ ...c, url: base })));
  }
  return ctx;
}

async function run(smoke: Smoke): Promise<DiagnosticsReport | null> {
  const raw = env("SMOKE_BASE_URL");
  if (!raw) throw new SmokeError("SMOKE_BASE_URL is required, e.g. SMOKE_BASE_URL=https://your-preview.vercel.app");
  let baseUrl: URL;
  try { baseUrl = new URL(raw); } catch { throw new SmokeError("SMOKE_BASE_URL is not a URL"); }
  if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") throw new SmokeError("SMOKE_BASE_URL must be http(s)");
  const base = baseUrl.origin;
  smoke.baseUrl = base;
  const how = chooseSignIn();
  smoke.signIn = how;
  if (!how) throw new SmokeError("No sign-in configured: set SMOKE_ADMIN_EMAIL (Clerk testing), SMOKE_STORAGE_STATE or SMOKE_SESSION_COOKIE");
  const timeoutMs = Number(env("SMOKE_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new SmokeError("SMOKE_TIMEOUT_MS must be a positive number of milliseconds");

  const exe = env("PW_CHROMIUM_PATH");
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), args: ["--autoplay-policy=no-user-gesture-required"] });
  } catch (e) {
    throw new SmokeError(`Could not start Chromium${exe ? "" : " (set PW_CHROMIUM_PATH to a Chromium binary)"}: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    const ctx = await newContext(browser, how, base);
    const page = await ctx.newPage();
    const log = (line: string) => { if (smoke.browserLog.length < MAX_LOG_LINES) smoke.browserLog.push(scrub(line).slice(0, 300)); };
    page.on("console", (m) => { if (m.type() === "error") log(`console: ${m.text()}`); });
    page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
    page.on("response", (r) => { try { if (r.status() >= 400 && new URL(r.url()).origin === base) log(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); } catch { /* ignore */ } });

    if (how === "clerk-testing") await signInWithClerk(page, base);

    const res = await page.goto(`${base}${PAGE_PATH}`, { waitUntil: "domcontentloaded" });
    const landed = new URL(page.url());
    if (landed.origin !== base || landed.pathname !== PAGE_PATH) {
      throw new SmokeError(`Not signed in as an admin: ${PAGE_PATH} sent the browser to ${landed.origin === base ? landed.pathname : landed.origin}`);
    }
    if (!res || res.status() >= 400) {
      const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 200);
      throw new SmokeError(`${PAGE_PATH} answered HTTP ${res?.status() ?? "?"}${text ? `: ${text}` : ""}`);
    }
    const button = page.getByTestId("diagnostics-run");
    try { await button.waitFor({ state: "visible", timeout: Math.min(30_000, timeoutMs) }); } catch { throw new SmokeError(`${PAGE_PATH} loaded but has no "Run check" button (is this deployment older than the diagnostics page?)`); }
    await button.click();

    const done = page.locator('[data-testid="diagnostics-result"][data-status="pass"], [data-testid="diagnostics-result"][data-status="fail"]');
    try { await done.waitFor({ state: "attached", timeout: timeoutMs }); } catch { throw new SmokeError(`Timed out after ${timeoutMs} ms waiting for the check to finish`); }
    const text = await page.getByTestId("diagnostics-json").textContent();
    try { return JSON.parse(text ?? "") as DiagnosticsReport; } catch { throw new SmokeError("The page's report is not valid JSON"); }
  } finally {
    await browser.close().catch(() => {});
  }
}

function judge(smoke: Smoke, report: DiagnosticsReport) {
  if (!report || typeof report !== "object" || !report.metrics || !("failure" in report)) { smoke.verdict = "FAIL: the page's report is missing its metrics"; return; }
  smoke.pageVerdict = typeof report.verdict === "string" ? report.verdict : null;
  const own = evaluate(report);
  smoke.pass = report.status === "pass" && own.pass;
  smoke.verdict = own.verdict;
  if (report.status === "pass" && !own.pass) smoke.warnings.push("The page reported PASS but its numbers do not meet PASS_CRITERIA: is the deployment running different criteria?");
  if (report.status !== "pass" && own.pass) { smoke.verdict = `FAIL: the page reported ${report.status}`; smoke.warnings.push("The page did not report PASS although its numbers meet PASS_CRITERIA"); }
  const c: Partial<DiagnosticsReport["cleanup"]> = report.cleanup ?? {};
  if (c.sessionEnded === false) smoke.warnings.push("The diagnostics session was not ended by the page (it bills nothing and the stale sweep closes it)");
  if (c.tracksStopped === false || c.peerClosed === false) smoke.warnings.push("The page did not confirm that the camera tracks and the peer connection were closed");
}

async function main() {
  const smoke: Smoke = {
    tool: "altrcam-smoke-realtime", baseUrl: null, page: PAGE_PATH, signIn: null, pass: false, verdict: "FAIL: did not run",
    pageVerdict: null, criteria: PASS_CRITERIA, startedAt: new Date().toISOString(), finishedAt: null, error: null, warnings: [], browserLog: [],
  };
  let report: DiagnosticsReport | null = null;
  const timeoutMs = Number(env("SMOKE_TIMEOUT_MS") ?? DEFAULT_TIMEOUT_MS);
  // A hard stop above everything the run itself waits for, so the script can never hang.
  const hardStop = (Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS) + FIRST_FRAME_WAIT_MS + 60_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    report = await Promise.race([
      run(smoke),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new SmokeError(`Gave up after ${hardStop} ms`)), hardStop); }),
    ]);
    if (report) judge(smoke, report);
  } catch (e) {
    smoke.error = scrub(e instanceof SmokeError ? e.message : `Unexpected error: ${(e as Error)?.message ?? String(e)}`);
    smoke.verdict = `FAIL: ${smoke.error}`;
  } finally {
    clearTimeout(timer);
  }
  smoke.finishedAt = new Date().toISOString();
  process.stdout.write(scrub(JSON.stringify({ smoke, report }, null, 2)) + "\n");
  process.exit(smoke.pass ? 0 : 1);
}

void main();
