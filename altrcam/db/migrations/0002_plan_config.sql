CREATE TABLE IF NOT EXISTS "plan_config" (
	"plan" "plan" PRIMARY KEY NOT NULL,
	"monthly_credits" integer NOT NULL,
	"max_session_seconds" integer NOT NULL,
	"max_resolution" text NOT NULL,
	"presets" integer NOT NULL,
	"history_days" integer,
	"clip_recording" boolean NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
-- Constraints mirror the bounds the admin API enforces, so a bad write can't brick refills or sessions.
ALTER TABLE "plan_config" ADD CONSTRAINT "plan_config_bounds" CHECK (
  "monthly_credits" BETWEEN 0 AND 1000000
  AND "max_session_seconds" BETWEEN 10 AND 14400
  AND "presets" BETWEEN 0 AND 1000
  AND ("history_days" IS NULL OR "history_days" BETWEEN 1 AND 3650)
  AND "max_resolution" IN ('low', 'high')
);
--> statement-breakpoint
-- RLS on with no policies, like every other table: only the server connection can read it.
ALTER TABLE "plan_config" ENABLE ROW LEVEL SECURITY;
