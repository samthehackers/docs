# AltrCam — Be anyone. Live.

Realtime AI video transformation on your webcam, as a real SaaS: accounts, plans, credits, payments, metering, history and an admin console.

**Stack:** Next.js 15 (App Router, TS strict) · Tailwind · Clerk · Supabase Postgres via Drizzle (server-side only) · Supabase Storage · fal.ai (`decart/lucy-2-5/realtime`) · Paystack + NOWPayments · Resend · Upstash Ratelimit · Vitest + Playwright · Vercel.

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

Env is validated with Zod at boot in production (`lib/env.ts`, `instrumentation.ts`); a missing variable fails the deploy instead of the first request.

## Environment

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET` | Clerk auth + svix webhook secret |
| `DATABASE_URL` | Supabase Postgres connection string (server only; the pooler URL works, `prepare:false` is set) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Storage only. No Supabase client runs in the browser |
| `FAL_KEY` | fal.ai key, used only by the server proxy |
| `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_PLAN_PRO_MONTHLY`, `PAYSTACK_PLAN_PRO_YEARLY` | Paystack |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | Crypto |
| `RESEND_API_KEY`, `EMAIL_FROM` | Receipts, low-credit alerts, ticket replies |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | Rate limiting |
| `CRON_SECRET` | ≥16 chars. Vercel sends it as `Authorization: Bearer …` to cron routes. The GitHub Actions stale-session sweep needs the **same value as a repo secret** (`GO_LIVE.md` section 4b) |
| `NEXT_PUBLIC_APP_URL` | e.g. `https://altrcam.com` |
| `PRICE_<PRODUCT>_NGN`, `PRICE_<PRODUCT>_USD` | Prices **in minor units** (kobo/cents), per currency: card (Paystack) charges NGN, crypto (NOWPayments) is priced in USD. A product whose price is unset is hidden and refused at checkout. Full list and the margin guard: `GO_LIVE.md`, "Pricing and payment variables" |

Plan limits have defaults in [`lib/plans.ts`](./lib/plans.ts) and can be overridden by an admin (Admin → Plans) without a deploy; server code reads the effective values through `getPlans()`. Prices are env vars (`PRICE_*_NGN` / `PRICE_*_USD`); until `PRICING_APPROVED=true` the pricing pages say they aren't final.

## Dashboard setup

**Supabase**
1. Create a project; copy the Postgres URL into `DATABASE_URL`.
2. Storage → create a **private** bucket named `uploads`.
3. Run `npm run db:migrate`. The second migration enables RLS on every table with no policies, so a leaked anon key reads nothing.

**Clerk**
1. Enable Email+password, Google and GitHub. Optionally enable TOTP (Multi-factor).
2. Webhooks → add endpoint `https://<domain>/api/webhooks/clerk` with events `user.created`, `user.updated`, `user.deleted`; copy the signing secret to `CLERK_WEBHOOK_SECRET`.
3. Admin role = `publicMetadata.role = "admin"` (set by `npm run db:seed -- <email>`). It is re-checked server-side in every `/api/admin/*` handler, in the `/admin` page itself and inside every admin data function (`lib/admin.ts`), not only in the layout: Next.js renders a layout and its page in parallel, so a layout redirect alone does not protect the page's data. Tests call the page and each data function directly as a signed-out visitor, a normal user and an admin (`tests/unit/admin-gate.test.ts`); a source check fails if the page ever runs its own database query. This has not been exercised against real Clerk.

**Paystack**
1. Create two NGN Plans (monthly, yearly) whose amounts equal `PRICE_PRO_MONTHLY_NGN` / `PRICE_PRO_YEARLY_NGN`; put the plan codes in env.
2. Settings → API & Webhooks → webhook URL `https://<domain>/api/webhooks/paystack`.

**NOWPayments:** IPN callback `https://<domain>/api/webhooks/nowpayments`; set the IPN secret. Crypto is offered for Lifetime and top-ups only (no recurring).

**fal.ai:** create an API key → `FAL_KEY`. The browser never sees it; it talks to `/api/fal/proxy`, which only forwards realtime-token requests for the Lucy app and only for a signed-in user with an open studio session.

**Vercel:** `vercel.json` registers crons: `/api/cron/refill` (monthly) and `/api/cron/retention` (daily: history purge + lapsed-plan downgrade). `/api/cron/stale-sessions` runs every 5 minutes from GitHub Actions (`.github/workflows/altrcam-sweep.yml`; Hobby only allows daily Vercel crons). It stays off until the repo variable `ALTRCAM_URL` and secret `CRON_SECRET` are set; see `GO_LIVE.md` section 4b.

## Testing locally

```bash
npm run typecheck && npm run lint && npm test
```

Unit tests (Vitest) cover plan config, ledger bucket ordering and no-overdraw, metering math, **fulfilment idempotency against a real in-memory Postgres (PGlite) running the production migrations**, and both providers' signature verification.

E2E (`npm run test:e2e`, Playwright + `@clerk/testing`) needs a Clerk **development** instance and a migrated Postgres. It signs up, hits the 0-credit gate, sends a validly signed `charge.success` to the webhook (server verification goes to a local mock via `PAYSTACK_API_URL`), checks the replay doesn't double-grant, and confirms the studio unlocks. CI runs typecheck/lint/unit always and e2e when the repo variable `E2E_ENABLED=true` and Clerk test secrets exist.

### Webhooks on localhost

```bash
cloudflared tunnel --url http://localhost:3000   # or: ngrok http 3000
# put https://<tunnel>/api/webhooks/{clerk,paystack,nowpayments} in each dashboard
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
- **Account deletion** — cancels subscriptions → deletes Storage files → anonymises payments (kept for accounting) → hard-deletes everything else → deletes the Clerk user.

## Layout

```
app/(marketing) (auth) (app) (admin)   app/api/{studio,fal,payments,webhooks,cron,admin,…}
lib/{db,plans,credits,metering,payments,fal,env,ratelimit,email,storage,…}
components/{ui,studio,billing,admin}   db/{schema.ts,migrations}   tests/{unit,e2e}
```
