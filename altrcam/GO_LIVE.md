# Go-live checklist

Everything below needs **your real accounts and credentials**. This repo has never been run against Clerk, Supabase, Paystack, NOWPayments, Resend, Upstash or fal.ai, so treat the first pass as the integration test. Work top to bottom; each step says how you know it worked.

> Do all of this on a **preview/staging** deployment with **test-mode** payment keys first. Switch to live keys only after section 9 passes.

Assumes the app is on `main` including: the CSP fix for production Clerk, build-without-credentials, admin plan limits, and the isolation/lifecycle tests.

## 0. What is and isn't proven today

| Proven here (automated) | Not proven (needs you) |
|---|---|
| Builds and serves public pages with **zero** credentials; protected routes answer 503 with a reason | Anything against a real Clerk, Supabase, Paystack, NOWPayments, Resend or Upstash account |
| Credit ledger, metering, plan limits, payment fulfilment idempotency and signature checks (real Postgres engine) | Real Paystack/NOWPayments payloads and webhook delivery |
| One user can't read, change, bill or cancel another's data; admin routes are admin-only | Sign-in, social login, email verification, 2FA |
| Lucy handshake order and teardown (with fal faked); responsive layout in real Chromium | **fal's real message format.** The first live Studio session is the test |

## 1. Decide your pricing first (this can sink the business)

`1 credit = 1 second of live video` and the defaults give every signup **300 free credits/month** and Pro **6,000 credits/month**. Your provider cost per second decides whether that is affordable:

```
cost per free signup per month = 300 × (fal $ per second)
cost of a fully used Pro month = 6,000 × (fal $ per second)
```

One search-result summary of a fal article put Lucy realtime at about **$0.04 per second of processed video**. I could not open fal's pricing page from the build environment, so **treat that as unverified and check fal's current price yourself**. If it is right, a free signup that uses all its credits costs ~$12 and a fully used Pro month ~$240, which no plausible subscription price covers. Confirm the real price, then:

- set allowances in **Admin → Plans** (no deploy needed; changes take effect within ~15 s and are audited);
- set prices with `PRICE_*` env vars (minor units: kobo/cents) and set `PRICING_APPROVED=true`. Until then pricing and billing show a "Pricing is not final" notice. The values in `.env.example` are placeholders, not recommendations.

## 2. Create the services

| Service | Do this | Gives you |
|---|---|---|
| **Supabase** | New project. Storage → create a **private** bucket named `uploads`. | `DATABASE_URL` (Settings → Database; pooler URL is fine), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| **Clerk** | New app. Enable Email+password, Google, GitHub; optional TOTP. For production create a **Production instance** and add the DNS records Clerk asks for (this creates `clerk.<your-domain>`). | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |
| **Paystack** | Create two Plans (monthly, yearly). Amount and currency **must equal** `PRICE_PRO_MONTHLY` / `PRICE_PRO_YEARLY` / `PRICE_CURRENCY`, or renewals are recorded as rejected. | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_PLAN_PRO_MONTHLY`, `PAYSTACK_PLAN_PRO_YEARLY` |
| **NOWPayments** (optional) | API key and IPN secret. | `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` |
| **fal.ai** | API key. | `FAL_KEY` |
| **Resend** | Add and verify your sending domain. | `RESEND_API_KEY`; set `EMAIL_FROM` on that domain |
| **Upstash** | New Redis (REST). | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |

Also: `CRON_SECRET` (`openssl rand -hex 24`), `NEXT_PUBLIC_APP_URL` (the real https URL), `NEXT_PUBLIC_SUPPORT_EMAIL` (an inbox someone reads), `PRICING_APPROVED`.

## 3. Check locally

```bash
cd altrcam
cp .env.example .env.local        # fill in every value
npm install
npm run db:migrate                # schema + RLS + plan_config
npm run preflight                 # read-only check of everything above
```

`preflight` should print no `FAIL`. It checks: env validates, every table in the schema exists, RLS is on for each, the `uploads` bucket exists and is **private**, the Clerk key works, both Paystack plans exist **and match your prices**, the NOWPayments key works, the Resend domain is verified, and Redis answers. It cannot check fal or webhook registration (sections 7 and 6).

Then make yourself the first admin: sign up in the running app, then `npm run db:seed -- you@example.com`. Nobody is ever admin automatically; the role is Clerk `publicMetadata.role = "admin"`, set only by that command (or by you in the Clerk dashboard).

## 4. Vercel: settings to verify

The project exists: **`altrcam`**, team *TrustGeeks Security lnc teams* (`geeeksteams`), id `prj_VkXMM1Wjo3b9wbol7PrDH5o4K3XM`. It was created with the settings below, but Vercel's API didn't echo them back, so **check each one in Settings**:

| Setting | Should be |
|---|---|
| Git repository | `samthehackers/docs`, production branch **`main`** |
| **Root Directory** | **`altrcam`** (the repo root is an unrelated docs site) |
| Framework preset | Next.js |
| **Node.js Version** | **22.x** (it defaulted to 24; `engines.node` in `package.json` also pins 22.x) |
| Install / Build / Output | defaults (`npm install`, `next build`, `.next`) |
| Ignored Build Step | `git diff --quiet HEAD^ HEAD -- .` (builds only when `altrcam/` changed, so docs commits don't trigger it) |
| Vercel Authentication | currently "all except custom domains": previews are private, the production domain is public. Decide whether you want that |
| Crons | read from `altrcam/vercel.json`: monthly refill, stale-session sweep **every 5 min** (needs a paid plan), daily retention. Check your plan allows the 300 s function limit set on the refill/retention routes |
| Domains | add `altrcam.com` and `altrcam.ai` (the app redirects `.ai` to `.com`) |
| Region | pick the one closest to your Supabase region |

**Environment variables:** add every variable above in *Settings → Environment Variables*. Use **different values per environment**: Preview gets the Clerk *development* instance and Paystack **test** keys; only Production gets live ones. `NEXT_PUBLIC_*` values are baked in at build time, so **redeploy after changing them**.

The app builds and serves public pages even with none of them set. `GET /api/health` on the deployed URL shows which integrations it considers configured (booleans only), a quick way to see what's still missing.

## 5. Merge and deploy to a preview first
Push a branch or open a PR; Vercel builds a preview. Open it, check `/api/health`, then run sections 6-8 against the preview URL.

## 6. Register webhooks (use the preview URL while testing)

| Where | URL | Events |
|---|---|---|
| Clerk → Webhooks | `https://<domain>/api/webhooks/clerk` | `user.created`, `user.updated`, `user.deleted`. Signing secret → `CLERK_WEBHOOK_SECRET` |
| Paystack → Settings → API & Webhooks | `https://<domain>/api/webhooks/paystack` | all (the app handles `charge.success`, `subscription.create`, `subscription.disable`, `subscription.not_renew`, `invoice.payment_failed`) |
| NOWPayments → IPN | `https://<domain>/api/webhooks/nowpayments` | payment status |

A bad signature returns 401, so a wrong secret shows up as webhook deliveries failing with 401 in the provider's dashboard. Preview URLs are behind Vercel Authentication; either turn that off for the webhook paths' environment or test webhooks against a custom preview domain.

## 7. Verify fal signaling: the riskiest step
`lib/fal/signaling.ts` implements ICE servers → offer → answer → ICE candidates → remote track over the `@fal-ai/client` realtime socket, but **the message names were written without fal's spec**. It uses the client's default message serialization, as fal's documented `fal.realtime.connect(...).send(obj)` usage does. Verify against the real service before anything else:

1. Sign in on the preview, open `/studio`, allow the camera.
2. DevTools → Network. Click **Go live**.
3. `POST /api/fal/proxy` should return **200** (the short-lived token). 403 = no active studio session (check `/api/studio/session/start`); 400 = see the guard in `app/api/fal/proxy/route.ts`.
4. Filter Network by **WS**; open the `wss://fal.run/decart/lucy-2-5/...` connection → **Messages**. Compare every frame with the `Incoming` / `Outgoing` types in `signaling.ts`: does fal send ICE servers first, under what field names? What does it expect in the offer, and what does the answer look like? Are frames binary (msgpack, the client default) or JSON text? If fal expects JSON text, add `encodeMessage`/`decodeMessage` options to `connect`.
5. If names differ, edit only `Outgoing`, `Incoming` and `handleIncoming`. The lifecycle tests in `tests/unit/signaling.test.ts` should keep passing (they fake fal) and will tell you if you break teardown.
6. **Success:** Connecting → Live within a few seconds, the right-hand video plays the transformed feed, the credit counter ticks down once a second, and the dashboard balance drops after a heartbeat (every 10 s).

| Symptom | Likely cause |
|---|---|
| Stuck on Connecting, "Timed out waiting for the model to answer" | wrong message names, or offer fields differ |
| `POST /api/fal/proxy` 403 | no active session: the `x-altrcam-session` header is missing/invalid |
| Connects, no video | answer applied but no `ontrack`: codecs/transceivers in the offer |
| Sign-in doesn't load on the production domain | CSP: confirm the Clerk host from your publishable key is in `script-src` (it is derived automatically; check the console) |

Also compare what fal actually **bills** for that session against the credits the app deducted.

## 8. End-to-end test (test mode)
- [ ] **Sign up with Google**: land on `/dashboard`; a `users` row exists with your FREE allowance (`signup_grant` in `credit_ledger`).
- [ ] **Email + password sign-up**: verification email arrives; reset-password works; 2FA can be enabled in Settings; Settings → Security (Clerk) lists your signed-in devices and lets you revoke each one. Clerk has no single "sign out everywhere" button, so don't promise one.
- [ ] **Studio**: go live, credits count down, Stop ends the session (`studio_sessions.ended_at` set, `seconds_billed` ≈ what you watched).
- [ ] **Cut-off at zero**: as admin, revoke credits down to ~15, go live, confirm the session stops by itself and `/studio` then says "out of credits".
- [ ] **Close the tab mid-session**: within ~5 min the stale-sweep cron closes it (`end_reason = stale`).
- [ ] **Pay with Paystack (test card)**: success page confirms; `payments` row `success`; plan PRO; credits reset to the Pro allowance; receipt email.
- [ ] **Replay that webhook** from Paystack's dashboard: balance does **not** change again.
- [ ] **Top-up** lands in the purchased bucket and survives a monthly refill.
- [ ] **Cancel subscription**: plan stays PRO until period end, then the daily retention cron downgrades it (after a 2-day grace).
- [ ] **Crypto** (if enabled): sandbox payment reaches `finished` and unlocks; `partially_paid` only notifies.
- [ ] **Snapshot** appears in History with a thumbnail; **Record clip** downloads (Pro).
- [ ] **Admin**: grant/revoke credits, change a user's plan, edit **Plans** limits; all appear in the audit log.
- [ ] **Delete account**: Clerk user, files and rows gone; payments remain, anonymised.
- [ ] **Public pages** render: `/how-it-works`, `/faq`, `/terms`, `/privacy`, `/contact`, a bad URL (branded 404), `/robots.txt`, `/sitemap.xml`.

## 9. Before switching to live money
- [ ] **Clerk Production** instance (dev keys are rate-limited and show a banner), **live** Paystack keys, all webhooks re-registered with the live secrets.
- [ ] A lawyer has reviewed `/terms` and `/privacy` (they are templates, marked as such on the page) and you've decided your refund policy. The Terms currently say payments are non-refundable except where the law requires.
- [ ] Remove the "Template text" banner from those pages only after that review.
- [ ] Prices approved → `PRICING_APPROVED=true`; allowances set from the real provider cost (section 1).
- [ ] `NEXT_PUBLIC_SUPPORT_EMAIL` is a monitored inbox.
- [ ] Keys live only in Vercel env (never committed); rotate anything ever pasted into a chat or ticket.
- [ ] Optional: set repo variable `E2E_ENABLED=true` with Clerk test-mode secrets so CI also runs the Playwright sign-up → pay → unlock test.
- [ ] Watch the first real payment end to end, and the first real session's cost in the fal dashboard.

## Known limits
See `README_LIMITATIONS.md`. In particular: a modified client can keep an open fal connection for up to ~2 minutes after the server stops billing, and a user can get up to ~10 s per session unbilled.
