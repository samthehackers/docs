import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { cleanDatabaseUrl, migrationDatabaseUrl, postgresOptions } from "../lib/database-url";

/** Uses DATABASE_URL, else POSTGRES_URL_NON_POOLING (direct connection), else POSTGRES_URL / POSTGRES_PRISMA_URL. */
async function main() {
  const raw = migrationDatabaseUrl();
  if (!raw) throw new Error("No database URL: set DATABASE_URL (or POSTGRES_URL_NON_POOLING / POSTGRES_URL from the Supabase integration)");
  const { url } = cleanDatabaseUrl(raw);
  const sql = postgres(url, postgresOptions(url, { max: 1 }));
  await migrate(drizzle(sql), { migrationsFolder: "db/migrations" });
  await sql.end();
  console.log("migrations applied");
}
main().catch((e) => { console.error(e); process.exit(1); });
