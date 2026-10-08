/**
 * scripts/sweep.sh run for real (bash + curl) against a local HTTP server that misbehaves on purpose.
 * This is what the scheduled GitHub Actions job executes, so its retry/exit-code/secret-handling semantics matter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../../scripts/sweep.sh");
const SECRET = "s3cr3t-value-that-must-never-be-printed";

type Seen = { url: string; auth: string | undefined };
let server: http.Server;
let base = "";
let seen: Seen[] = [];
let handler: (req: http.IncomingMessage, res: http.ServerResponse, n: number) => void = (_q, r) => r.end();

beforeAll(async () => {
  server = http.createServer((req, res) => { seen.push({ url: req.url ?? "", auth: req.headers.authorization }); handler(req, res, seen.length); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections?.(); server.close(); });
beforeEach(() => { seen = []; handler = (_q, r) => r.end(); });

const json = (res: http.ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

function run(args: string[] = [], env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const e: Record<string, string | undefined> = { PATH: process.env.PATH, SWEEP_RETRY_DELAY: "0", ALTRCAM_URL: base, CRON_SECRET: SECRET, ...env };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    execFile("bash", [SCRIPT, ...args], { env: e as NodeJS.ProcessEnv, timeout: 30_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, out: stdout, err: stderr });
    });
  });
}
const never = (r: { out: string; err: string }) => expect(r.out + r.err).not.toContain(SECRET);

describe("sweep.sh", () => {
  it("succeeds on 2xx, calls the stale-sessions endpoint by default and sends the bearer secret", async () => {
    handler = (_q, res) => json(res, 200, { closed: 3 });
    const r = await run();
    expect(r.code).toBe(0);
    expect(r.out).toContain('{"closed":3}');
    expect(seen).toEqual([{ url: "/api/cron/stale-sessions", auth: `Bearer ${SECRET}` }]);
    never(r);
  });
  it("can call the other cron endpoints", async () => {
    for (const ep of ["refill", "retention"]) { seen = []; expect((await run([ep])).code).toBe(0); expect(seen[0].url).toBe(`/api/cron/${ep}`); }
  });
  it("tolerates a trailing slash on the URL", async () => {
    expect((await run([], { ALTRCAM_URL: `${base}/` })).code).toBe(0);
    expect(seen[0].url).toBe("/api/cron/stale-sessions");
  });
  it("rejects an unknown endpoint without making a request (no path injection)", async () => {
    for (const ep of ["nope", "../admin", "stale-sessions/../refill", "refill;id"]) {
      const r = await run([ep]);
      expect(r.code, ep).toBe(2);
    }
    expect(seen).toEqual([]);
  });
  it("401: reports a secret mismatch, does NOT retry, and never prints the secret", async () => {
    handler = (_q, res) => json(res, 401, { error: "Unauthorized" });
    const r = await run([], { SWEEP_ATTEMPTS: "5" });
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(1);
    expect(r.err).toMatch(/CRON_SECRET/);
    never(r);
  });
  it("retries a flaky server and succeeds", async () => {
    handler = (_q, res, n) => (n < 3 ? json(res, 503, { error: "cold start" }) : json(res, 200, { closed: 0 }));
    const r = await run([], { SWEEP_ATTEMPTS: "3" });
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(3);
  });
  it("gives up with a non-zero exit after the configured attempts when the server keeps failing", async () => {
    handler = (_q, res) => json(res, 500, { error: "boom" });
    const r = await run([], { SWEEP_ATTEMPTS: "4" });
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(4);
    expect(r.err).toMatch(/giving up/);
    never(r);
  });
  it("times out a hanging server and fails instead of hanging the job", async () => {
    handler = () => { /* never answers */ };
    const t0 = Date.now();
    const r = await run([], { SWEEP_ATTEMPTS: "2", SWEEP_TIMEOUT: "1" });
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);
  it("fails cleanly when the connection is refused", async () => {
    const r = await run([], { ALTRCAM_URL: "http://127.0.0.1:1", SWEEP_ATTEMPTS: "2" });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/failed \(HTTP 000\)/);
    never(r);
  });
  it("does not follow redirects (the secret must not be forwarded to another URL)", async () => {
    // Redirect to ANOTHER PATH ON THIS SAME SERVER: a client that follows would hit /leaked with the secret and "succeed".
    handler = (q, res) => {
      if (q.url === "/leaked") return json(res, 200, { closed: 99 });
      res.writeHead(301, { location: "/leaked" });
      res.end();
    };
    const r = await run([], { SWEEP_ATTEMPTS: "2" });
    expect(r.code).toBe(1);
    expect(seen.map((x) => x.url)).toEqual(["/api/cron/stale-sessions", "/api/cron/stale-sessions"]); // never /leaked
    never(r);
  });
  it("refuses a non-https, non-localhost URL with its own config error (exit 2) before sending anything", async () => {
    for (const url of ["http://altrcam.com", "ftp://x.example", "altrcam.com", "https://"]) {
      const r = await run([], { ALTRCAM_URL: url });
      expect(r.code, url).toBe(2);
      expect(r.err, url).toMatch(/https/);
    }
    expect((await run([], { ALTRCAM_URL: "" })).code).not.toBe(0); // empty counts as not set
    expect(seen).toEqual([]);
  });
  it("fails with a clear message when not configured", async () => {
    const a = await run([], { ALTRCAM_URL: undefined });
    expect(a.code).not.toBe(0); expect(a.err).toMatch(/ALTRCAM_URL/);
    const b = await run([], { CRON_SECRET: undefined });
    expect(b.code).not.toBe(0); expect(b.err).toMatch(/CRON_SECRET/);
    expect(seen).toEqual([]);
  });
});
