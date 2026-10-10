import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";
import { cleanDatabaseUrl, databaseUrl, postgresOptions } from "@/lib/database-url";

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function client() {
  if (!globalThis.__sql) {
    const raw = databaseUrl();
    if (!raw) throw new Error("No database URL: set DATABASE_URL (or POSTGRES_URL from the Supabase integration)");
    // Integration URLs carry parameters postgres.js would send to the server as startup parameters (and fail); strip them.
    // prepare:false is required for Supabase's transaction pooler.
    const { url } = cleanDatabaseUrl(raw);
    globalThis.__sql = postgres(url, postgresOptions(url, { max: 5 }));
  }
  return globalThis.__sql;
}

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;
export function db() {
  if (!_db) _db = drizzle(client(), { schema });
  return _db;
}
export type DB = ReturnType<typeof db>;
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
export { schema };
