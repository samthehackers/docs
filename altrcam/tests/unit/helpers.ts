import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { DB } from "@/lib/db";

/** In-memory real Postgres (PGlite) with the production migrations applied. */
export async function testDb() {
  const client = new PGlite();
  const d = drizzle(client, { schema });
  await migrate(d, { migrationsFolder: "db/migrations" });
  return d as unknown as DB;
}
