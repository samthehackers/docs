import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@/db/schema";

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function client() {
  if (!globalThis.__sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // prepare:false is required for Supabase's transaction pooler.
    globalThis.__sql = postgres(url, { prepare: false, max: 5 });
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
