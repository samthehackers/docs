/**
 * One answer to "which Postgres URL does the app use", shared by the app, the scripts and the config checks.
 *
 * Order: `DATABASE_URL` (set by hand) → `POSTGRES_URL` (the Supabase transaction pooler, set by the Vercel Supabase
 * integration) → `POSTGRES_PRISMA_URL` (same pooler, Prisma flavoured). Migrations prefer `POSTGRES_URL_NON_POOLING`
 * (a direct/session connection) when it is present, because DDL inside the transaction pooler is fragile.
 *
 * The integration URLs carry query parameters that postgres.js does not understand, e.g.
 * `?sslmode=require&supa=base-pooler.x` or `?pgbouncer=true&connect_timeout=15`. postgres.js forwards every query
 * parameter it does not recognise to the server as a startup parameter, and the server then refuses the connection with
 * `unrecognized configuration parameter "supa"`. So the URL is cleaned to the parameters postgres.js really uses.
 */

type Env = Record<string, string | undefined>;

const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** The runtime URL (app requests): DATABASE_URL ?? POSTGRES_URL ?? POSTGRES_PRISMA_URL. */
export function databaseUrl(env: Env = process.env): string | undefined {
  return nonEmpty(env.DATABASE_URL) ?? nonEmpty(env.POSTGRES_URL) ?? nonEmpty(env.POSTGRES_PRISMA_URL);
}

/** The URL for migrations: a direct connection when the integration provides one, else the runtime URL. */
export function migrationDatabaseUrl(env: Env = process.env): string | undefined {
  return nonEmpty(env.DATABASE_URL) ?? nonEmpty(env.POSTGRES_URL_NON_POOLING) ?? databaseUrl(env);
}

/** The variable names that are checked, for error messages (never values). */
export const DATABASE_URL_NAMES = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL"] as const;

/**
 * Query parameters postgres.js itself understands (src/index.js parseOptions). Anything else would be sent to the
 * server as a startup parameter. `application_name` is a real server parameter and harmless, so it is kept.
 */
const KNOWN = new Set([
  "sslmode", "ssl", "sslrootcert", "sslnegotiation",
  "connect_timeout", "idle_timeout", "max_lifetime", "keep_alive",
  "target_session_attrs", "application_name",
]);

export interface CleanedUrl { url: string; dropped: string[] }

/** Strips unknown query parameters. Keeps the credentials, host, port, database and SSL settings exactly. */
export function cleanDatabaseUrl(raw: string): CleanedUrl {
  const q = raw.indexOf("?");
  if (q === -1) return { url: raw, dropped: [] };
  const base = raw.slice(0, q);
  const params = new URLSearchParams(raw.slice(q + 1));
  const kept = new URLSearchParams();
  const dropped: string[] = [];
  for (const [k, v] of params) {
    if (KNOWN.has(k)) kept.append(k, v); else dropped.push(k);
  }
  const qs = kept.toString();
  return { url: qs ? `${base}?${qs}` : base, dropped };
}

/** Hosted Supabase requires TLS. If the URL says nothing about SSL and points at Supabase, require it. */
export function sslFor(url: string): "require" | undefined {
  const q = url.indexOf("?");
  const params = new URLSearchParams(q === -1 ? "" : url.slice(q + 1));
  if (params.has("sslmode") || params.has("ssl")) return undefined; // postgres.js reads it from the URL
  let host = "";
  try { host = new URL(url.replace(/^postgres(ql)?:/, "http:")).hostname; } catch { return undefined; }
  return /(^|\.)supabase\.(co|com)$/.test(host) ? "require" : undefined;
}

/** postgres.js options for a URL from this module: transaction-pooler safe (no prepared statements). */
export function postgresOptions(url: string, extra: { max?: number } = {}) {
  const ssl = sslFor(url);
  return { prepare: false as const, max: extra.max ?? 5, ...(ssl ? { ssl } : {}) };
}
