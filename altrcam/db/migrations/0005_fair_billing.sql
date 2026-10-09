-- Fair billing: a session is billed only from its first transformed frame (live_at), an early drop can be refunded once,
-- and the Studio's use rule must be accepted before going live. Columns and one index only, no new table, so the RLS of
-- 0001 and the revoked API-role grants of 0004 already cover everything here.
ALTER TABLE "studio_sessions" ADD COLUMN "live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_sessions" ADD COLUMN "refunded_credits" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "consent_accepted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_session_refund_uq" ON "credit_ledger" USING btree ("ref_type","ref_id","bucket") WHERE "credit_ledger"."reason" = 'session_refund';--> statement-breakpoint
-- Every session that exists before this migration was billed from its start, so record that as its live time. Without
-- this, a session still open at deploy time would look as if it never went live (closed unbilled), and sessions closed
-- just before the deploy would count towards the never-connected cooldown on the next Go live.
UPDATE "studio_sessions" SET "live_at" = "started_at" WHERE "live_at" IS NULL;
