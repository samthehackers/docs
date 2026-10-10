/**
 * The database URL the app connects with. Production has no DATABASE_URL: the Vercel Supabase integration sets POSTGRES_URL
 * (transaction pooler), POSTGRES_PRISMA_URL and POSTGRES_URL_NON_POOLING, with extra query parameters that postgres.js
 * would otherwise forward to the server as startup parameters. Credentials below are fake.
 */
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { cleanDatabaseUrl, databaseUrl, migrationDatabaseUrl, postgresOptions, sslFor } from "@/lib/database-url";

const POOLER = "postgres://postgres.abcdefghijklmnopqrst:fake%2Fp%40ss@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x";
const PRISMA = "postgres://postgres.abcdefghijklmnopqrst:fakepass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x&pgbouncer=true&connection_limit=1&connect_timeout=15";
const DIRECT = "postgres://postgres.abcdefghijklmnopqrst:fakepass@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require";

/** What postgres.js would do with a URL: the options it parses, without connecting. */
const parsed = (url: string) => (postgres(url, postgresOptions(url)) as unknown as { options: { host: string[]; port: number[]; user: string; pass: string; database: string; ssl: unknown; prepare: boolean; connection: Record<string, string>; connect_timeout: number } }).options;

describe("which URL", () => {
  it("prefers DATABASE_URL, then POSTGRES_URL, then POSTGRES_PRISMA_URL; blanks count as unset", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://a", POSTGRES_URL: POOLER })).toBe("postgres://a");
    expect(databaseUrl({ POSTGRES_URL: POOLER, POSTGRES_PRISMA_URL: PRISMA })).toBe(POOLER);
    expect(databaseUrl({ DATABASE_URL: "  ", POSTGRES_URL: "", POSTGRES_PRISMA_URL: PRISMA })).toBe(PRISMA);
    expect(databaseUrl({})).toBeUndefined();
  });
  it("migrations prefer the direct (non-pooling) connection when there is no DATABASE_URL", () => {
    expect(migrationDatabaseUrl({ POSTGRES_URL: POOLER, POSTGRES_URL_NON_POOLING: DIRECT })).toBe(DIRECT);
    expect(migrationDatabaseUrl({ POSTGRES_URL: POOLER })).toBe(POOLER);
    expect(migrationDatabaseUrl({ DATABASE_URL: "postgres://a", POSTGRES_URL_NON_POOLING: DIRECT })).toBe("postgres://a");
  });
});

describe("cleaning integration URLs for postgres.js", () => {
  it("without cleaning, postgres.js would send `supa` and `pgbouncer` to the server as startup parameters (the failure being fixed)", () => {
    const raw = (postgres(PRISMA, { prepare: false }) as unknown as { options: { connection: Record<string, string> } }).options.connection;
    expect(raw).toMatchObject({ supa: "base-pooler.x", pgbouncer: "true", connection_limit: "1" });
  });
  it("drops unknown parameters and keeps SSL and timeouts", () => {
    expect(cleanDatabaseUrl(POOLER)).toEqual({ url: POOLER.replace("&supa=base-pooler.x", ""), dropped: ["supa"] });
    const c = cleanDatabaseUrl(PRISMA);
    expect(c.dropped.sort()).toEqual(["connection_limit", "pgbouncer", "supa"]);
    expect(c.url).toContain("sslmode=require");
    expect(c.url).toContain("connect_timeout=15");
  });
  it("leaves a URL with no query, or only known parameters, untouched", () => {
    expect(cleanDatabaseUrl("postgres://u:p@localhost:5432/db")).toEqual({ url: "postgres://u:p@localhost:5432/db", dropped: [] });
    expect(cleanDatabaseUrl(DIRECT)).toEqual({ url: DIRECT, dropped: [] });
  });
  it("the cleaned pooler URL parses to the right host, port, user, encoded password and database, with TLS and no prepared statements", () => {
    const o = parsed(cleanDatabaseUrl(POOLER).url);
    expect(o.host).toEqual(["aws-0-eu-central-1.pooler.supabase.com"]);
    expect(o.port).toEqual([6543]);
    expect(o.user).toBe("postgres.abcdefghijklmnopqrst");
    expect(o.pass).toBe("fake/p@ss");
    expect(o.database).toBe("postgres");
    expect(o.ssl).toBe("require");
    expect(o.prepare).toBe(false);
    expect(Object.keys(o.connection)).toEqual(["application_name"]); // nothing unknown reaches the server
  });
  it("the cleaned Prisma URL keeps its connect timeout as a client option, not a server parameter", () => {
    const o = parsed(cleanDatabaseUrl(PRISMA).url);
    expect(o.connect_timeout).toBe(15);
    expect(Object.keys(o.connection)).toEqual(["application_name"]);
  });
});

describe("TLS", () => {
  it("requires TLS for a Supabase host whose URL says nothing about it", () => {
    expect(sslFor("postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres")).toBe("require");
    expect(sslFor("postgres://u:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres")).toBe("require");
    expect(parsed("postgres://u:p@db.abcdefghijklmnopqrst.supabase.co:5432/postgres").ssl).toBe("require");
  });
  it("leaves the URL's own sslmode alone, and local or other hosts as they are", () => {
    expect(sslFor(DIRECT)).toBeUndefined();
    expect(parsed("postgres://u:p@aws.pooler.supabase.com:6543/postgres?sslmode=disable").ssl).toBe(false);
    expect(sslFor("postgres://postgres:postgres@127.0.0.1:54322/postgres")).toBeUndefined();
    expect(sslFor("postgres://u:p@notsupabase.com.evil.io/db")).toBeUndefined();
  });
});
