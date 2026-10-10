# AltrCam — Be anyone. Live.

Realtime AI video transformation on your webcam, as a real SaaS: accounts, plans, credits, payments, metering, history and an admin console.

**Stack:** Next.js 15 (App Router, TS strict) · Tailwind · Supabase Auth (`@supabase/ssr`) · Supabase Postgres via Drizzle (server-side only) · Supabase Storage · fal.ai (`decart/lucy-2-5/realtime`) · Paystack + NOWPayments · Resend · Upstash Ratelimit · Vitest + Playwright · Vercel.

> **Going live? Follow [`GO_LIVE.md`](./GO_LIVE.md)** (ordered checklist, `npm run preflight`, exact Vercel settings). Read [`README_LIMITATIONS.md`](./README_LIMITATIONS.md) first. In particular, the fal WebRTC signaling message schema is **unverified** and has not been exercised against the real service.

## Quick start

```bash
cd altrcam
cp .env.example .env.local      # fill in every value (see below)
npm install
npm run db:migrate              # applies db/migrations (schema + RLS)
npm run dev
npm run db:seed -- you@example.com   # after signing up once: makes that user an admin
```

Env is checked with Zod at boot in production (`lib/env.ts`, `instrumentation.ts`). A missing variable is logged by name (never its value) but is **not fatal**: public pages keep working and each feature that needs a missing variable says so (`GET /api/health` lists what is configured). Signed-in pages need Supabase Auth and a database; everything else is optional.

## Environment

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (or the legacy `NEXT_PUBLIC_SUPABASE_ANON_KEY`) | Supabase Auth in the browser and on the server (sessions live in cookies, refreshed by `middleware.ts`). Set by the Vercel Supabase integration |
| `DATABASE_URL`, else `POSTGRES_URL`, else `POSTGRES_PRISMA_URL` | Postgres for the app (server only). The Vercel Supabase integration sets the `POSTGRES_*` ones (transaction pooler); `lib/database-url.ts` strips the integration's extra query parameters (`supa`, `pgbouncer`, …) that postgres.js would otherwise send to the server, keeps `sslmode`, and uses `prepare:false` |
| `POSTGRES_URL_NON_POOLING` | Used by `npm run db:migrate` when there is no `DATABASE_URL` (a direct connection for DDL) |
| `SUPABASE_URL`, `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`) | Server only: Storage, and deleting the Auth user on account deletion. Never in a `NEXT_PUBLIC_` variable |
| `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED` | `true` shows "Continue with Google". Set it only after enabling the Google provider in Supabase (Authentication → Providers); a button for a disabled provider just fails |
| `FAL_KEY` | fal.ai key, used only by the server proxy |
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_PLAN_PRO_MONTHLY`, `PAYSTACK_PLAN_PRO_YEARLY` | Paystack |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | Crypto |
| `RESEND_API_KEY`, `EMAIL_FROM` | Receipts, low-credit alerts, ticket replies |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Rate limiting. Without them production falls back to a per-instance in-memory limiter (weaker, but nothing breaks) |
| `CRON_SECRET` | ≥16 chars. Vercel sends it as `Authorization: Bearer …` to cron routes. The GitHub Actions stale-session sweep needs the **same value as a repo secret** (`GO_LIVE.md` section 4b) |
| `NEXT_PUBLIC_APP_URL` | e.g. `https://altrcam.com`. Used for referral links, payment return URLs and emails; when unset, Vercel's `VERCEL_PROJECT_PRODUCTION_URL` is used |
| `PRICE_CURRENCY` (`NGN`\|`USD`), `PRICE_*` | Prices **in minor units** (kobo/cents). Webhooks compare paid amounts against these |

Plan limits have defaults in [`lib/plans.ts`](./lib/plans.ts) and can be overridden by an admin (Admin → Plans) without a deploy; server code reads the effective values through `getPlans()`. Prices are env vars (`PRICE_*`); until `PRICING_APPROVED=true` the pricing pages say they aren't final.

## Dashboard setup

**Supabase (database + storage)**
1. Create a project (or connect it to Vercel with the Supabase integration, which sets the `POSTGRES_*` and `SUPABASE_*` variables).
2. Storage → create a **private** bucket named `uploads`.
3. Run `npm run db:migrate`. The second migration enables RLS on every table with no policies, so a leaked anon key reads nothing; the server connects as the database owner.

**Supabase Auth** (details in `GO_LIVE.md` section 2b)
1. Authentication → URL Configuration: Site URL = your production URL; Redirect URLs include `https://<domain>/**` (it must cover `/auth/callback` with its `?next=` query).
2. Email provider with **Confirm email** on. App pages refuse an unconfirmed email server-side (`requireAppUser` → `/verify-email`, APIs → 403). Set up custom SMTP before real users: Supabase's built-in sender is heavily rate-limited.
3. Email links: `/auth/callback` handles the default `{{ .ConfirmationURL }}` (PKCE `code`) links; `/auth/confirm` handles `token_hash` + `type` templates, which also work when the link is opened in another browser. Password reset lands on `/settings/password`.
4. Google (optional): enable the provider in Supabase, then set `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=true`.
5. There is no sign-up webhook: the first signed-in page creates the `users` row and the signup credits (`ensureUserRow`).
6. Admin role = `app_metadata.role = "admin"` on the Supabase user (only settable with the secret key or SQL, never by the user). Set it with `npm run db:seed -- <email>` or the SQL in `GO_LIVE.md`. It is re-checked server-side in every `/api/admin/*` handler, in the `/admin` page itself and inside every admin data function (`lib/admin.ts`), not only in the layout: Next.js renders a layout and its page in parallel, so a layout redirect alone does not protect the page's data. Tests call the page and each data function directly as a signed-out visitor, a normal user and an admin (`tests/unit/admin-gate.test.ts`), and the local Supabase e2e checks it with real Auth.

**Paystack**
1. Create two Plans (monthly, yearly) whose amounts equal `PRICE_PRO_MONTHLY` / `PRICE_PRO_YEARLY`; put the plan codes in env.
2. Settings → API & Webhooks → webhook URL `https://<domain>/api/webhooks/paystack`.

**NOWPayments:** IPN callback `https://<domain>/api/webhooks/nowpayments`; set the IPN secret. Crypto is offered for Lifetime and top-ups only (no recurring).

**fal.ai:** create an API key → `FAL_KEY`. The browser never sees it; it talks to `/api/fal/proxy`, which only forwards realtime-token requests for the Lucy app and only for a signed-in user with an open studio session.

**Vercel:** `vercel.json` registers crons: `/api/cron/refill` (monthly) and `/api/cron/retention` (daily: history purge + lapsed-plan downgrade). `/api/cron/stale-sessions` runs every 5 minutes from GitHub Actions (`.github/workflows/altrcam-sweep.yml`; Hobby only allows daily Vercel crons). It stays off until the repo variable `ALTRCAM_URL` and secret `CRON_SECRET` are set; see `GO_LIVE.md` section 4b.

## Testing locally

```bash
npm run typecheck && npm run lint && npm test
```

Unit tests (Vitest) cover plan config, ledger bucket ordering and no-overdraw, metering math, **fulfilment idempotency against a real in-memory Postgres (PGlite) running the production migrations**, and both providers' signature verification.

Integration tests (`npm run test:integration`) run the app's code on a real PostgreSQL through the production driver; set `TEST_DATABASE_URL` to an **empty scratch database** (they truncate tables).

E2E against a **local** Supabase stack (Docker + Supabase CLI; never a hosted project):

```bash
npm run test:e2e:local     # scripts/e2e-local.sh: supabase start → migrations → build → Playwright
# where the default registry is blocked: SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io npm run test:e2e:local
# other port / browser: E2E_PORT=3206 PW_CHROMIUM_PATH=/path/to/chrome npm run test:e2e:local
```

It uses `supabase/config.toml` (email confirmations on, Mailpit catching emails on port 54324) and starts the app with the Vercel integration's env names (a `POSTGRES_URL` carrying `supa=…`) and without fal, payment, Resend or Upstash keys. `tests/e2e/supabase-local.spec.ts` signs up, confirms through the emailed link (also from a second browser), signs in, opens every signed-in route and checks real data (ledger balance, referral code, stored ticket and preset), signs out, checks a second user can't read or change the first user's history or sessions, checks `/admin` and `/api/admin/*` refuse a normal user and admit one with `app_metadata.role = "admin"`, resets the password through the emailed link, checks auth links never redirect off-site, and deletes an account (rows and Supabase login gone). The specs skip themselves when no local stack is running. CI runs typecheck/lint/unit/public always, integration always, and the local-Supabase e2e when the repo variable `E2E_ENABLED=true`.

### Webhooks on localhost

```bash
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
# put https://<tunnel>/api/webhooks/{paystack,nowpayments} in each dashboard
```

Hand-fire a Paystack event (needs a real `reference` from a pending `payments` row, and Paystack test keys so verification succeeds):

```bash
BODY='{"event":"charge.success","data":{"reference":"alt_..."}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac "$PAYSTACK_SECRET_KEY" | awk '{print $2}')
curl -X POST localhost:3000/api/webhooks/paystack -H "x-paystack-signature: $SIG" -d "$BODY"
```

## How the important parts work

- **Credits** — `credit_ledger` is append-only; balance = `SUM(delta)` per bucket (`monthly`, `purchased`). `users.credits_*` is a cache updated in the same transaction. Debits take monthly first. The monthly cron expires unused monthly credits; purchased top-ups never expire.
- **Metering** — `POST /api/studio/session/heartbeat` every 10 s. The server bills whole seconds from **its own clock**, row-locked, capped by plan session length and balance; it returns `{remaining, continue}` and the client tears down at `continue:false`. A cron closes sessions with no heartbeat for 30 s, billed up to the last heartbeat.
- **Payments** — a pending `payments` row pins user/product/price when checkout starts. The webhook verifies the signature on the raw body (constant-time), re-verifies with the provider server-to-server, checks amount/currency/product against `lib/plans.ts`, then `fulfilPayment` runs one transaction: `webhook_events` unique insert (duplicate = no-op) → payment transition to `success` (only the first transition proceeds) → plan/subscription → ledger grant → notification → audit log; the receipt email is sent after commit. The success page only polls status — it never grants.
- **Account deletion** — cancels subscriptions → deletes Storage files → anonymises payments (kept for accounting) → hard-deletes everything else → deletes the Supabase Auth user (server-side, with the secret key).
- **Auth** — Supabase sessions in cookies (`lib/supabase/{client,server,proxy}.ts`). Every server check uses `auth.getUser()` (verified with the Auth server, never just the cookie). `middleware.ts` refreshes the session, sends signed-out visitors to `/sign-in` (APIs get 401), and answers 503 with a reason when Auth or the database isn't configured. Sign-out is a form POST to `/auth/sign-out`. `/auth/callback` and `/auth/confirm` accept only same-origin `next` paths.

## Layout

```
app/(marketing) (auth) (app) (admin)   app/api/{studio,fal,payments,webhooks,cron,admin,…}
lib/{db,plans,credits,metering,payments,fal,env,ratelimit,email,storage,…}
components/{ui,studio,billing,admin}   db/{schema.ts,migrations}   tests/{unit,integration,public,e2e}   supabase/config.toml (local e2e only)
```
