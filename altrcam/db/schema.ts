import {
  pgTable, text, integer, timestamp, jsonb, real, index, uniqueIndex, serial, bigserial, pgEnum, boolean,
} from "drizzle-orm/pg-core";

export const planEnum = pgEnum("plan", ["FREE", "PRO", "LIFETIME"]);
export const bucketEnum = pgEnum("credit_bucket", ["monthly", "purchased"]);
export const paymentKind = pgEnum("payment_kind", ["subscription", "lifetime", "topup"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(), // Clerk user id
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  avatarUrl: text("avatar_url"),
  role: text("role").notNull().default("user"),
  plan: planEnum("plan").notNull().default("FREE"),
  planStatus: text("plan_status").notNull().default("active"),
  planRenewsAt: timestamp("plan_renews_at", { withTimezone: true }),
  referralCode: text("referral_code").unique(),
  referredBy: text("referred_by"),
  notifyEmail: boolean("notify_email").notNull().default(true),
  /** Cached balance; ledger is the source of truth and this is updated in the same transaction. */
  creditsMonthly: integer("credits_monthly").notNull().default(0),
  creditsPurchased: integer("credits_purchased").notNull().default(0),
  lowCreditNotifiedAt: timestamp("low_credit_notified_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  provider: text("provider").notNull(),
  providerSubId: text("provider_sub_id").notNull(),
  emailToken: text("email_token"),
  plan: planEnum("plan").notNull(),
  status: text("status").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAt: timestamp("cancel_at", { withTimezone: true }),
}, (t) => [index("subs_user_idx").on(t.userId), uniqueIndex("subs_provider_uq").on(t.provider, t.providerSubId)]);

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  userId: text("user_id"), // nullable: anonymised on account deletion, rows kept for accounting
  provider: text("provider").notNull(),
  reference: text("reference").notNull().unique(),
  kind: paymentKind("kind").notNull(),
  product: text("product").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  currency: text("currency").notNull(),
  status: text("status").notNull(),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("payments_user_idx").on(t.userId)]);

export const webhookEvents = pgTable("webhook_events", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(),
  eventId: text("event_id").notNull().unique(),
  type: text("type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  payload: jsonb("payload"),
});

export const creditLedger = pgTable("credit_ledger", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  delta: integer("delta").notNull(),
  bucket: bucketEnum("bucket").notNull(),
  reason: text("reason").notNull(),
  refType: text("ref_type"),
  refId: text("ref_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("ledger_user_created_idx").on(t.userId, t.createdAt)]);

export const studioSessions = pgTable("studio_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  secondsBilled: integer("seconds_billed").notNull().default(0),
  maxSeconds: integer("max_seconds").notNull(),
  presetId: integer("preset_id"),
  settings: jsonb("settings"),
  avgFps: real("avg_fps"),
  avgLatencyMs: real("avg_latency_ms"),
}, (t) => [index("sessions_user_ended_idx").on(t.userId, t.endedAt)]);

export const transformations = pgTable("transformations", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  sessionId: text("session_id"),
  title: text("title").notNull(),
  prompt: text("prompt").notNull().default(""),
  type: text("type").notNull().default("custom"),
  settings: jsonb("settings"),
  thumbnailUrl: text("thumbnail_url"),
  exportUrl: text("export_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("transformations_user_idx").on(t.userId, t.createdAt)]);

export const presets = pgTable("presets", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  prompt: text("prompt").notNull().default(""),
  imagePath: text("image_url"), // storage path, signed on read
  settings: jsonb("settings"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("presets_user_idx").on(t.userId)]);

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)]);

export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("open"),
  adminReply: text("admin_reply"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("tickets_user_idx").on(t.userId)]);

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Admin overrides for plan limits. A missing row means "use the defaults in lib/plans.ts". */
export const planConfig = pgTable("plan_config", {
  plan: planEnum("plan").primaryKey(),
  monthlyCredits: integer("monthly_credits").notNull(),
  maxSessionSeconds: integer("max_session_seconds").notNull(),
  maxResolution: text("max_resolution").notNull(), // low | high
  presets: integer("presets").notNull(),
  historyDays: integer("history_days"), // null = keep forever
  clipRecording: boolean("clip_recording").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const referrals = pgTable("referrals", {
  id: serial("id").primaryKey(),
  referrerId: text("referrer_id").notNull().references(() => users.id),
  referredId: text("referred_id").notNull().unique().references(() => users.id), // one referrer per user
  status: text("status").notNull().default("pending"), // pending | rewarded | capped
  rewardCredits: integer("reward_credits"),
  rewardedAt: timestamp("rewarded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("referrals_referrer_idx").on(t.referrerId)]);
