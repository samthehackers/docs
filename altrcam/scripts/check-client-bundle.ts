/**
 * After `next build`: fail if the VALUE of any server-only secret appears in the build output. `.next/static` is what
 * browsers download; `.next/server` holds prerendered HTML and RSC payloads, which are sent to browsers too.
 *
 *   FAL_KEY=fake-fal-key-for-bundle-check npm run build
 *   FAL_KEY=fake-fal-key-for-bundle-check npx tsx scripts/check-client-bundle.ts [path/to/.next]
 *
 * Use distinctive fake values, never real ones: the point is to see whether a value set at build time ends up in the
 * output. Prints variable names and file paths only, never values. Exit 0 = clean, 1 = found, or nothing to check.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Server-only secrets (lib/env.ts). Values shorter than MIN_LEN are skipped: too generic to search for. */
const SECRETS = [
  "FAL_KEY", "CLERK_SECRET_KEY", "CLERK_WEBHOOK_SECRET", "DATABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "PAYSTACK_SECRET_KEY",
  "NOWPAYMENTS_API_KEY", "NOWPAYMENTS_IPN_SECRET", "RESEND_API_KEY", "UPSTASH_REDIS_REST_TOKEN", "CRON_SECRET",
];
const MIN_LEN = 8;
const SCAN = ["static", "server"];

function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) files(f, out); else out.push(f);
  }
  return out;
}

function main() {
  const nextDir = path.resolve(process.argv[2] ?? ".next");
  const checks = SECRETS.map((name) => ({ name, value: process.env[name] ?? "" })).filter((c) => c.value.length >= MIN_LEN);
  if (!checks.length) {
    console.log(`Nothing to check: set at least FAL_KEY (>= ${MIN_LEN} characters, a fake value) for the build and for this script.`);
    process.exit(1);
  }
  const dirs = SCAN.map((d) => path.join(nextDir, d)).filter((d) => existsSync(d));
  if (!dirs.some((d) => d.endsWith(`${path.sep}static`))) {
    console.log(`No ${path.join(nextDir, "static")}: run \`next build\` first.`);
    process.exit(1);
  }
  const needles = checks.map((c) => ({ name: c.name, bytes: Buffer.from(c.value) }));
  const found: string[] = [];
  let scanned = 0;
  for (const dir of dirs) {
    for (const f of files(dir)) {
      const buf = readFileSync(f);
      scanned++;
      for (const n of needles) if (buf.includes(n.bytes)) found.push(`${n.name} in ${path.relative(process.cwd(), f)}`);
    }
  }
  const names = checks.map((c) => c.name).join(", ");
  if (found.length) {
    console.log(`FAIL: server secret values found in the build output (${scanned} files scanned in ${SCAN.join(" and ")}):`);
    for (const line of found) console.log(`  ${line}`);
    process.exit(1);
  }
  console.log(`OK: ${scanned} files in ${dirs.map((d) => path.relative(process.cwd(), d)).join(" and ")} contain none of: ${names}`);
}

main();
