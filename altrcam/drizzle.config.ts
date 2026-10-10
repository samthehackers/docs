import { defineConfig } from "drizzle-kit";
import { cleanDatabaseUrl, migrationDatabaseUrl } from "./lib/database-url";
const raw = migrationDatabaseUrl();
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: raw ? cleanDatabaseUrl(raw).url : "" },
});
