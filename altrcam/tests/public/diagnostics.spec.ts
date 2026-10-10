/**
 * /admin/diagnostics in a real browser, with no credentials:
 *  1. The page and its API answer 503 like every other protected route when sign-in is not configured.
 *  2. The check's measuring code works with real Chromium WebRTC: the real runner and synthetic camera, connected to a
 *     LOCAL loopback peer instead of fal (tests/public/diagnostics-harness.ts). This proves the tool measures; it does
 *     not prove anything about fal or Lucy. Only a run against the real service does (docs/REALTIME_VERIFICATION.md).
 */
import { expect, test } from "@playwright/test";
import { buildSync } from "esbuild";
import path from "node:path";
import { PASS_CRITERIA, type DiagnosticsReport } from "../../lib/diagnostics/criteria";

// Top-level (Playwright forbids launchOptions in a describe). Host candidates as plain IPs: the loopback peers are in one
// page and cannot rely on mDNS in a container. Harmless for the other test here.
test.use({
  launchOptions: {
    ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--autoplay-policy=no-user-gesture-required"],
  },
});

test("the diagnostics page and its API are protected routes (503 without sign-in configured)", async ({ page, request }) => {
  const res = await page.goto("/admin/diagnostics");
  expect(res?.status()).toBe(503);
  await expect(page.locator("body")).toContainText("Sign-in is not configured");
  for (const p of ["/api/admin/diagnostics/session", "/api/admin/diagnostics/session/end"]) {
    expect((await request.post(p, { data: {} })).status(), p).toBe(503);
  }
});

test.describe("measuring against real Chromium WebRTC (local loopback, no fal)", () => {
  test("a full check passes on a loopback and every number comes from the browser", async ({ page }) => {
    test.setTimeout(90_000);
    const bundle = buildSync({
      entryPoints: [path.resolve(__dirname, "diagnostics-harness.ts")], bundle: true, write: false, format: "iife",
      platform: "browser", target: "chrome110", tsconfig: path.resolve(__dirname, "../../tsconfig.json"), logLevel: "silent",
    }).outputFiles[0].text;
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.setContent('<canvas id="c"></canvas><video id="v" muted playsinline autoplay></video>');
    await page.addScriptTag({ content: bundle });
    const { report: r, calls } = await page.evaluate(() =>
      (window as unknown as { __diagnosticsHarness: { runLoopback: () => Promise<{ report: DiagnosticsReport; calls: { url: string; body: { result?: { pass?: boolean } } | null }[] }> } }).__diagnosticsHarness.runLoopback());

    expect(errors).toEqual([]);
    expect(r.failure, JSON.stringify(r.steps)).toBeNull();
    expect(r.status, r.verdict).toBe("pass");
    const m = r.metrics;
    expect(m.firstFrameSource).toBe("requestVideoFrameCallback");
    expect(m.timeToFirstFrameMs).toBeGreaterThan(0);
    expect(m.timeToFirstFrameMs).toBeLessThanOrEqual(PASS_CRITERIA.firstFrameMaxMs);
    expect(m.fps).toBeGreaterThanOrEqual(PASS_CRITERIA.minFps); // the synthetic camera sends 30 fps
    expect(m.fps).toBeLessThanOrEqual(35);
    expect(m.displayedFps).toBeGreaterThan(0);
    expect(m.resolution?.width).toBeGreaterThan(0);
    expect(m.resolution?.width).toBeLessThanOrEqual(640);
    expect(m.rttMs, "RTT from the receiving peer's candidate pair").not.toBeNull();
    expect(m.jitterMs).not.toBeNull();
    expect(m.packetLossPct).not.toBeNull();
    expect(m.sampleMs).toBeGreaterThanOrEqual(PASS_CRITERIA.sampleMs);
    expect(r.samples.length).toBeGreaterThanOrEqual(10);
    expect(r.cleanup).toEqual({ tracksStopped: true, peerClosed: true, connectionClosed: true, sessionEnded: true, sessionEndStatus: 200 });
    const names = r.steps.map((s) => s.name);
    for (const s of ["synthetic_camera_started", "session_created", "connect_started", "offer_sent", "answer_applied", "connected", "remote_stream", "first_frame", "sampling_finished", "session_ended"]) expect(names, s).toContain(s);
    expect(calls.map((c) => c.url)).toEqual(["/api/admin/diagnostics/session", "/api/admin/diagnostics/session/end"]);
    expect(calls[1].body?.result?.pass).toBe(true);
    test.info().annotations.push({ type: "loopback metrics", description: JSON.stringify(m) });
  });
});
