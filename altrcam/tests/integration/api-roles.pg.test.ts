/**
 * Migration 0004 on a REAL PostgreSQL that has Supabase's public API roles. A plain test database does not have
 * `anon` / `authenticated`, so this creates them, gives them what Supabase gives them (everything, including on
 * tables created later), runs the migration, and checks that nothing is left, now or for new tables.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@host:5432/an_empty_database npm run test:integration
 *
 * Skipped (not failed) when TEST_DATABASE_URL is unset. Needs a role that can create roles (a superuser). It leaves
 * the two roles behind in the cluster, which is harmless.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { readFileSync } from "node:fs";
import path from "node:path";

const URL_ = process.env.TEST_DATABASE_URL;
const suite = URL_ ? describe : describe.skip;

suite("migration 0004: revoke the public API roles' privileges (real PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(URL_!, { max: 1, prepare: false, onnotice: () => {} });
    await migrate(drizzle(sql), { migrationsFolder: "db/migrations" }); // all migrations apply with no such roles present
  });
  afterAll(async () => { await sql?.end(); });

  const grants = async () =>
    (await sql`select count(*)::int as n from information_schema.role_table_grants where table_schema = 'public' and grantee in ('anon', 'authenticated')`)[0].n as number;

  it("removes everything Supabase's default grants gave them, and the defaults for tables created later", async () => {
    await sql.unsafe(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    end $$`);
    // What Supabase does by default:
    await sql.unsafe(`grant usage on schema public to anon, authenticated;
      grant all on all tables in schema public to anon, authenticated;
      alter default privileges in schema public grant all on tables to anon, authenticated;`);
    expect(await grants()).toBeGreaterThan(0);

    const migration = readFileSync(path.resolve("db/migrations/0004_revoke_api_role_grants.sql"), "utf8");
    await sql.unsafe(migration);
    await sql.unsafe(migration); // and it can be run again
    expect(await grants()).toBe(0);

    await sql.unsafe(`create table if not exists api_role_probe (id int)`);
    try { expect(await grants()).toBe(0); } finally { await sql.unsafe(`drop table if exists api_role_probe`); }
  });
});
