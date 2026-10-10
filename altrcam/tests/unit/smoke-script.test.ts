/**
 * scripts/smoke-realtime.ts run for real (tsx + headless Chromium) against a local HTTP server that imitates the
 * /admin/diagnostics page CONTRACT: a "Run check" button, then a result section with data-status and the report JSON.
 * The reports served here are fixtures written for the test, not results of any real run.
 *
 * What this proves: how the script signs in (cookie, storage state), what it waits for, that it applies PASS_CRITERIA
 * itself (a page claiming PASS with failing numbers is a FAIL), its exit codes, and that it never prints the cookie or a
 * fal token the page echoes. What it does NOT prove: the Clerk testing sign-in against a real Clerk instance, or anything
 * about the real page or fal. The Chromium tests are skipped when no Chromium binary is available (set PW_CHROMIUM_PATH).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";
import { emptyMetrics, PASS_CRITERIA, type DiagnosticsReport } from "@/lib/diagnostics/criteria";

const SCRIPT = path.resolve(__dirname, "../../scripts/smoke-realtime.ts");
const TSX = path.resolve(__dirname, "../../node_modules/.bin/tsx");
const CHROMIUM = process.env.PW_CHROMIUM_PATH || (() => { try { return chromium.executablePath(); } catch { return ""; } })();
const HAVE_CHROMIUM = !!CHROMIUM && existsSync(CHROMIUM);
const FAL_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJmYWwiOiJ0b2tlbiJ9.c2lnbmF0dXJlLXZhbHVl";
const cookieFor = (mode: string) => `smoke-cookie-secret-${mode}-7f3a9c`;

function fixtureReport(over: Partial<DiagnosticsReport> = {}): DiagnosticsReport {
  return {
    tool: "altrcam-realtime-diagnostics", version: 1, status: "pass", verdict: "PASS: first frame in 2.0 s, 24.0 fps over 10.0 s",
    startedAt: "2026-10-10T10:00:00.000Z", finishedAt: "2026-10-10T10:00:13.000Z", durationMs: 13000,
    endpoint: "http://127.0.0.1", app: "decart/lucy-2-5/realtime", prompt: "p", criteria: PASS_CRITERIA, sessionId: "s",
    steps: [], serverMessages: [], counts: { localCandidates: 0, remoteCandidates: 0, serverMessages: 0 },
    metrics: { ...emptyMetrics(), timeToFirstFrameMs: 2000, firstFrameSource: "requestVideoFrameCallback", fps: 24, sampleMs: 10000 },
    samples: [], failure: null,
    cleanup: { tracksStopped: true, peerClosed: true, connectionClosed: true, sessionEnded: true, sessionEndStatus: 200 },
    ...over,
  };
}
const REPORTS: Record<string, DiagnosticsReport> = {
  pass: fixtureReport(),
  fail: fixtureReport({ status: "fail", verdict: "FAIL: answer_timeout: Timed out waiting for the model to answer", failure: { code: "answer_timeout", message: "Timed out waiting for the model to answer" }, metrics: emptyMetrics() }),
  liar: fixtureReport({ metrics: { ...emptyMetrics(), timeToFirstFrameMs: 2000, fps: 5, sampleMs: 10000 } }), // claims PASS at 5 fps
};

function page(mode: string) {
  if (mode === "nobutton") return "<h1>Admin</h1>";
  const report = REPORTS[mode] ?? REPORTS.pass;
  return `<!doctype html><title>Realtime diagnostics</title><button data-testid="diagnostics-run">Run check</button>
<script>
const REPORT = ${JSON.stringify(report).replace(/</g, "\\u003c")};
document.querySelector("button").onclick = () => {
  // What a real browser does on a failed fal socket: echo its URL, token included. And a page bug echoing cookies.
  console.error("WebSocket connection to 'wss://fal.run/decart/lucy-2-5/realtime?fal_jwt_token=${FAL_TOKEN}' failed");
  console.error("cookies: " + document.cookie);
  if (${JSON.stringify(mode)} === "never") return;
  setTimeout(() => {
    const s = document.createElement("section");
    s.setAttribute("data-testid", "diagnostics-result");
    s.setAttribute("data-status", "running");
    const pre = document.createElement("pre");
    pre.setAttribute("data-testid", "diagnostics-json");
    pre.textContent = JSON.stringify({ ...REPORT, status: "running" });
    s.append(pre); document.body.append(s);
    setTimeout(() => { pre.textContent = JSON.stringify(REPORT); s.setAttribute("data-status", REPORT.status); }, 300);
  }, 100);
};
</script>`;
}

let server: http.Server;
let base = "";
const seenCookies: string[] = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/admin/diagnostics") {
      const cookie = req.headers.cookie ?? "";
      seenCookies.push(cookie);
      const mode = ["pass", "fail", "liar", "never", "nobutton", "error"].find((m) => cookie.includes(`__session=${cookieFor(m)}`));
      if (!mode) { res.writeHead(307, { location: "/sign-in" }); res.end(); return; }
      if (mode === "error") { res.writeHead(500, { "content-type": "text/html" }); res.end("<p>Internal error</p>"); return; }
      res.writeHead(200, { "content-type": "text/html" }); res.end(page(mode)); return;
    }
    if (url.pathname === "/sign-in") { res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>Sign in</h1>"); return; }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });

type Output = { smoke: Record<string, unknown> & { pass: boolean; verdict: string; error: string | null; warnings: string[]; browserLog: string[] }; report: DiagnosticsReport | null };
function run(env: Record<string, string | undefined>) {
  return new Promise<{ code: number; out: string; err: string; json: Output }>((resolve) => {
    const e: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PW_CHROMIUM_PATH: HAVE_CHROMIUM ? CHROMIUM : undefined, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    execFile(TSX, [SCRIPT], { env: e as NodeJS.ProcessEnv, timeout: 90_000, cwd: path.resolve(__dirname, "../..") }, (error, stdout, stderr) => {
      let json = { smoke: {}, report: null } as unknown as Output;
      try { json = JSON.parse(stdout) as Output; } catch { /* asserted below */ }
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr, json });
    });
  });
}
const neverPrints = (r: { out: string; err: string }, ...secrets: string[]) => { for (const s of secrets) expect(r.out + r.err).not.toContain(s); };

describe("configuration errors (no browser needed)", () => {
  it("requires SMOKE_BASE_URL", async () => {
    const r = await run({ SMOKE_SESSION_COOKIE: "__session=x" });
    expect(r.code).toBe(1);
    expect(r.json.smoke.error).toMatch(/SMOKE_BASE_URL is required/);
  });
  it("requires a sign-in method", async () => {
    const r = await run({ SMOKE_BASE_URL: base });
    expect(r.code).toBe(1);
    expect(r.json.smoke.error).toMatch(/No sign-in configured/);
  });
  it("rejects a non-http URL", async () => {
    const r = await run({ SMOKE_BASE_URL: "file:///etc/passwd", SMOKE_SESSION_COOKIE: "__session=x" });
    expect(r.code).toBe(1);
    expect(r.json.smoke.error).toMatch(/must be http/);
  });
}, 60_000);

describe.runIf(HAVE_CHROMIUM).concurrent("driving the page in headless Chromium", () => {
  it("PASS: signs in with the cookie, clicks Run, waits for the final report, prints it and exits 0", async () => {
    const r = await run({ SMOKE_BASE_URL: base, SMOKE_SESSION_COOKIE: `__session=${cookieFor("pass")}; __client_uat=1760000000` });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.smoke).toMatchObject({ pass: true, signIn: "session-cookie", baseUrl: base, verdict: "PASS: first frame in 2.0 s, 24.0 fps over 10.0 s", error: null });
    expect(r.json.report?.status).toBe("pass"); // the final report, not the "running" one shown first
    expect(seenCookies.some((c) => c.includes(cookieFor("pass")))).toBe(true);
    // The page echoed a fal token and the cookie to the console: both are redacted in what the script prints.
    expect(r.json.smoke.browserLog.join("\n")).toContain("fal_jwt_token=[redacted]");
    neverPrints(r, cookieFor("pass"), FAL_TOKEN);
  });

  it("FAIL: reports the page's failure and exits 1", async () => {
    const r = await run({ SMOKE_BASE_URL: base, SMOKE_SESSION_COOKIE: `__session=${cookieFor("fail")}` });
    expect(r.code).toBe(1);
    expect(r.json.smoke).toMatchObject({ pass: false, verdict: "FAIL: answer_timeout: Timed out waiting for the model to answer" });
    neverPrints(r, cookieFor("fail"));
  });

  it("applies PASS_CRITERIA itself: a page that claims PASS at 5 fps is a FAIL", async () => {
    const r = await run({ SMOKE_BASE_URL: base, SMOKE_SESSION_COOKIE: `__session=${cookieFor("liar")}` });
    expect(r.code).toBe(1);
    expect(r.json.smoke.pass).toBe(false);
    expect(r.json.smoke.verdict).toBe("FAIL: 5.0 fps over the sample (need at least 10)");
    expect(r.json.smoke.warnings.join(" ")).toMatch(/reported PASS but its numbers do not meet PASS_CRITERIA/);
  });

  it("not signed in as an admin (redirected away): exits 1 and says so", async () => {
    const r = await run({ SMOKE_BASE_URL: base, SMOKE_SESSION_COOKIE: "__session=wrong-cookie-value-123" });
    expect(r.code).toBe(1);
    expect(r.json.smoke.error).toBe("Not signed in as an admin: /admin/diagnostics sent the browser to /sign-in");
    neverPrints(r, "wrong-cookie-value-123");
  });

  it("an error page, a page without the button, and a check that never finishes all exit 1", async () => {
    const [e500, nobutton, never] = await Promise.all([
      run({ SMOKE_BASE_URL: base, SMOKE_SESSION_COOKIE: `__session=${cookieFor("error")}` }),
      run({ SMOKE_BASE_URL: base, SMOKE_SESSION_COOKIE: `__session=${cookieFor("nobutton")}`, SMOKE_TIMEOUT_MS: "2000" }),
      run({ SMOKE_BASE_URL: base, SMOKE_SESSION_COOKIE: `__session=${cookieFor("never")}`, SMOKE_TIMEOUT_MS: "2000" }),
    ]);
    expect([e500.code, nobutton.code, never.code]).toEqual([1, 1, 1]);
    expect(e500.json.smoke.error).toMatch(/answered HTTP 500/);
    expect(nobutton.json.smoke.error).toMatch(/no "Run check" button/);
    expect(never.json.smoke.error).toBe("Timed out after 2000 ms waiting for the check to finish");
  });

  it("signs in from a Playwright storage state file, whose cookie is never printed", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "smoke-state-"));
    const file = path.join(dir, "admin.json");
    const u = new URL(base);
    writeFileSync(file, JSON.stringify({ cookies: [{ name: "__session", value: cookieFor("pass"), domain: u.hostname, path: "/", expires: -1, httpOnly: true, secure: false, sameSite: "Lax" }], origins: [] }));
    const r = await run({ SMOKE_BASE_URL: base, SMOKE_STORAGE_STATE: file });
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.json.smoke).toMatchObject({ pass: true, signIn: "storage-state" });
    neverPrints(r, cookieFor("pass"));
  });

  it("Clerk testing sign-in without the target's Clerk keys fails clearly, exit 1", async () => {
    const r = await run({ SMOKE_BASE_URL: base, SMOKE_ADMIN_EMAIL: "admin@example.com" });
    expect(r.code).toBe(1);
    expect(r.json.smoke).toMatchObject({ signIn: "clerk-testing" });
    expect(r.json.smoke.error).toMatch(/^Clerk testing setup failed: .*CLERK_PUBLISHABLE_KEY/);
  });
}, 90_000);
