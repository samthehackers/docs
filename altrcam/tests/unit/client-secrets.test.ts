/**
 * FAL_KEY (and every other server secret) never reaches code that runs in the browser.
 *
 * Next only inlines `process.env.NEXT_PUBLIC_*` (and anything listed under `env` in next.config) into browser bundles, so
 * a secret can only leak by being renamed NEXT_PUBLIC_*, exposed through next.config `env`, or rendered by a page. This
 * checks the source: every module that can run in the browser (each "use client" file and everything it imports, with
 * type-only imports skipped since they are erased) reads no server env var, and FAL_KEY is referenced only where it is
 * meant to be. The built output is checked separately by scripts/check-client-bundle.ts (see docs/REALTIME_VERIFICATION.md).
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const SOURCE_DIRS = ["app", "components", "lib"];
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) walk(f, out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name)) out.push(f);
  }
  return out;
}
const SOURCES = SOURCE_DIRS.flatMap((d) => walk(path.join(ROOT, d)));
const read = (f: string) => readFileSync(f, "utf8");
const isClientEntry = (src: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(src);

function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null; // a package
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

/** Value imports of a module (type-only imports and exports are erased by the compiler, so they bring no code). */
function imports(src: string): string[] {
  const out: string[] = [];
  const stmt = /(?:^|\n)\s*(import|export)\s+(type\s+)?([\s\S]*?)\bfrom\s+["']([^"']+)["']/g;
  for (const m of src.matchAll(stmt)) if (!m[2]) out.push(m[4]);
  for (const m of src.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

function clientGraph() {
  const seen = new Set<string>();
  const queue = SOURCES.filter((f) => isClientEntry(read(f)));
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of imports(read(f))) { const r = resolve(f, spec); if (r && !seen.has(r)) queue.push(r); }
  }
  return [...seen].map(rel).sort();
}

/** `process.env[...]`: the literal name, or `<computed: expr>` for anything else (brackets balanced). */
function bracketName(rest: string): string {
  const lit = rest.match(/^\s*["']([^"']+)["']\s*\]/);
  if (lit) return lit[1];
  let depth = 1, i = 0;
  for (; i < rest.length && depth; i++) { if (rest[i] === "[") depth++; else if (rest[i] === "]") depth--; }
  return `<computed: ${rest.slice(0, i - 1).trim()}>`;
}

const SECRET_NAME = /FAL_KEY|SECRET|SERVICE_ROLE|TOKEN|PASSWORD|PRIVATE|DATABASE_URL|API_KEY/;

describe("code that can run in the browser", () => {
  const graph = clientGraph();

  it("is found (the walker follows the Studio's and the diagnostics page's imports)", () => {
    for (const f of ["components/studio/studio.tsx", "lib/studio-session.ts", "lib/fal/signaling.ts", "lib/fal/config.ts", "components/admin/diagnostics-panel.tsx", "lib/diagnostics/run.ts", "lib/diagnostics/criteria.ts"]) {
      expect(graph, f).toContain(f);
    }
    for (const f of ["app/api/fal/proxy/route.ts", "lib/admin-diagnostics.ts", "lib/config.ts", "lib/env.ts"]) expect(graph, f).not.toContain(f);
  });

  /**
   * Non-public env reads that are allowed in browser-reachable modules, and why. In the browser they read `undefined`.
   * lib/plans.ts is reachable because the Studio imports its constants; expectedPrice() (server callers only) reads the
   * PRICE_* variables, which are prices, not secrets.
   */
  const ALLOWED_READS: Record<string, string[]> = { "lib/plans.ts": ["PRICE_CURRENCY", "<computed: PRODUCTS[product].priceEnv>"] };

  it("never mentions FAL_KEY, never reads a secret or unreviewed env var, never imports the server proxy", () => {
    const bad: string[] = [];
    for (const f of graph) {
      const src = read(path.join(ROOT, f));
      if (/FAL_KEY/.test(src)) bad.push(`${f}: mentions FAL_KEY`);
      for (const m of src.matchAll(/process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[)/g)) {
        const name = m[1] ?? bracketName(src.slice((m.index ?? 0) + m[0].length));
        if (name.startsWith("NEXT_PUBLIC_") || name === "NODE_ENV") continue;
        if (SECRET_NAME.test(name) || !(ALLOWED_READS[f] ?? []).includes(name)) bad.push(`${f}: reads process.env ${name}`);
      }
      if (/@fal-ai\/server-proxy/.test(src)) bad.push(`${f}: imports @fal-ai/server-proxy`);
    }
    expect(bad).toEqual([]);
  });
});

describe("FAL_KEY in the source", () => {
  it("is referenced only by the token proxy (through @fal-ai/server-proxy's config), the env schema and the presence check", () => {
    const refs = SOURCES.filter((f) => /FAL_KEY/.test(read(f))).map(rel).sort();
    expect(refs).toEqual(["app/api/fal/proxy/route.ts", "lib/config.ts", "lib/env.ts"]);
  });
  it("is never exposed under a NEXT_PUBLIC_ name, and no NEXT_PUBLIC_ name looks like a secret", () => {
    const files = [...SOURCES, ...["next.config.ts", "middleware.ts", "instrumentation.ts"].map((f) => path.join(ROOT, f)).filter(existsSync)];
    const names = new Set(files.flatMap((f) => [...read(f).matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)].map((m) => m[0])));
    expect([...names].filter((n) => SECRET_NAME.test(n.replace(/^NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY$/, "")))).toEqual([]);
    expect([...names].sort()).toEqual(["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPPORT_EMAIL"]);
  });
  it("next.config exposes no env to the client bundle", () => {
    const cfg = read(path.join(ROOT, "next.config.ts"));
    expect(cfg).not.toMatch(/\benv\s*:/);
    expect(cfg).not.toMatch(/FAL_KEY|process\.env\.(?!NEXT_PUBLIC_)/);
  });
});
