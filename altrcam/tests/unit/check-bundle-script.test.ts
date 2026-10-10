/**
 * scripts/check-client-bundle.ts run for real (tsx) against small fake `.next` directories: it finds a secret's value
 * wherever it is in static or server output, names the variable and file, and never prints the value.
 * The real check (after a real `next build` with a fake FAL_KEY) is a manual step: docs/REALTIME_VERIFICATION.md.
 */
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/check-client-bundle.ts");
const TSX = path.resolve(__dirname, "../../node_modules/.bin/tsx");
const FAKE = "fake-fal-key-value-5e0c1d-NOT-REAL";

function nextDir(files: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bundle-check-"));
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), content);
  }
  return dir;
}
function run(dir: string, env: Record<string, string>) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(TSX, [SCRIPT, dir], { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } as unknown as NodeJS.ProcessEnv, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout + stderr });
    });
  });
}

describe("check-client-bundle", () => {
  it("passes a clean build", async () => {
    const r = await run(nextDir({ "static/chunks/app.js": "console.log('hi')", "server/app/index.html": "<p>ok</p>" }), { FAL_KEY: FAKE });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^OK: 2 files in .* contain none of: FAL_KEY/);
  });
  it.each([
    ["a client chunk", "static/chunks/page-abc.js", `const k="${FAKE}";`],
    ["prerendered HTML", "server/app/pricing.html", `<script>self.__next_f.push("${FAKE}")</script>`],
  ])("fails when the value is in %s, naming the variable and file but never the value", async (_n, file, content) => {
    const r = await run(nextDir({ [file]: content, "static/other.js": "x" }), { FAL_KEY: FAKE });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAL_KEY in `);
    expect(r.out).toContain(path.basename(file));
    expect(r.out).not.toContain(FAKE);
  });
  it("refuses to report OK when there is nothing to look for, or no build", async () => {
    expect((await run(nextDir({ "static/a.js": "x" }), {})).code).toBe(1);
    expect((await run(nextDir({ "server/a.js": "x" }), { FAL_KEY: FAKE })).out).toMatch(/run `next build` first/);
  });
}, 60_000);
