# Go-live checklist

Everything below needs **your real accounts and credentials**. Sign-up, email confirmation, sign-in, every signed-in page, sign-out, admin and password reset have been run end to end against a **local** Supabase stack (`npm run test:e2e:local`), but never against the hosted project, and nothing here has run against Paystack, NOWPayments, Resend, Upstash or fal.ai, so treat the first pass as the integration test. Work top to bottom; each step says how you know it worked.

> Do all of this on a **preview/staging** deployment with **test-mode** payment keys first. Switch to live keys only after section 9 passes.

Assumes the app is on `main` including: Supabase Auth, the database URL fallback to the integration's `POSTGRES_URL`, build-without-credentials, admin plan limits, and the isolation/lifecycle tests.

## 0. What is and isn't proven today

| Proven here (automated) | Not proven (needs you) |
|---|---|
| Builds and serves public pages with **zero** credentials; protected routes answer 503 with a reason | Anything against the hosted Supabase project, or a real Paystack, NOWPayments, Resend or Upstash account |
| Credit ledger, metering, plan limits, payment fulfilment idempotency and signature checks (real Postgres engine) | Real Paystack/NOWPayments payloads and webhook delivery |
| One user can't read, change, bill or cancel another's data; admin routes are admin-only. With a **local** Supabase stack: sign-up + emailed confirmation, sign-in, every signed-in page with real data, sign-out, admin via `app_metadata`, password reset by email | The hosted project's Auth settings (Site URL, redirect URLs, SMTP, templates), Google sign-in, real inbox delivery |
| Studio against a **fake** fal: the offer goes out first and ICE candidates queue behind the first reply (checked through the real `@fal-ai/client`), teardown on every exit path, a failed connection ends its billed session and keeps its reason on screen; responsive layout in real Chromium | **fal's real message format and ordering.** Whether the live service replies, in what shape, and accepts the token request. The first live Studio session is the test |

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
| **Supabase** (database, storage and Auth) | **Already done** for this deployment and connected to Vercel through the Supabase integration, see "The database" below. For another environment: new project, connect the integration (or set the variables by hand), apply the migrations, create a **private** bucket named `uploads`, and do section 2b. | From the integration: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`/`_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`/`SUPABASE_SERVICE_ROLE_KEY`, `POSTGRES_URL`, `POSTGRES_PRISMA_URL`, `POSTGRES_URL_NON_POOLING`. The app uses `DATABASE_URL` if set, else `POSTGRES_URL` |
| **Paystack** | Create two Plans (monthly, yearly). Amount and currency **must equal** `PRICE_PRO_MONTHLY` / `PRICE_PRO_YEARLY` / `PRICE_CURRENCY`, or renewals are recorded as rejected. | `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `PAYSTACK_PLAN_PRO_MONTHLY`, `PAYSTACK_PLAN_PRO_YEARLY` |
| **NOWPayments** (optional) | API key and IPN secret. | `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` |
| **fal.ai** | API key. | `FAL_KEY` |
| **Resend** | Add and verify your sending domain. | `RESEND_API_KEY`; set `EMAIL_FROM` on that domain |
| **Upstash** | New Redis (REST). | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |

Also: `CRON_SECRET` (`openssl rand -hex 24`), `NEXT_PUBLIC_APP_URL` (the real https URL), `NEXT_PUBLIC_SUPPORT_EMAIL` (an inbox someone reads), `PRICING_APPROVED`.

### The database (already created)

Supabase project **`altrcam`**, ref `jyaxfxtaengddgdqohzp`, region **us-east-1** (next to Vercel's `iad1` functions), `SUPABASE_URL=https://jyaxfxtaengddgdqohzp.supabase.co`. It is on the organisation's **free plan**.

What is already in place and checked:
- Migrations `0000`-`0003` are applied (13 tables, row-level security on every one, no policies) and recorded in `drizzle.__drizzle_migrations`, so `npm run db:migrate` skips them. They were applied through Supabase's SQL API rather than the Drizzle runner, because the database password is not available to the tooling that created it.
- The public API roles (`anon`, `authenticated`) have **no privileges** on the app's tables, now and for tables created later (migration `0004` holds this SQL; it was applied by hand, and `db:migrate` will run it once more harmlessly).
- A **private** `uploads` bucket exists.
- Supabase's security checks report only "RLS enabled, no policy" (13 times, which is the design: the API roles read nothing; the server connects as the database owner). Smoke-tested by inserting a user, ledger row, referral, plan config and session and rolling them back; the plan-limit CHECK constraint rejects out-of-bounds rows.

What is still yours to do:
- [ ] Nothing to copy for the database: the Supabase integration already sets `POSTGRES_URL` (transaction pooler), which the app now uses when `DATABASE_URL` is unset (before this fix every signed-in page failed with "DATABASE_URL is not set"). Don't add a `DATABASE_URL` unless you mean to override it. Check the integration's variables are scoped to the environments you want; do not point Preview deployments at the production database (use a separate Supabase project or branch for previews).
- [ ] Do section 2b (Auth settings).
- [ ] **Free-plan limits:** the project is **paused after a week without activity**, and I believe the free plan has no automatic backups (check Settings → Database → Backups). Move to **Pro** before taking real users.
- [ ] Run `npm run preflight` with the real variables. It checks the tables, RLS, the private bucket and the other services.
- [ ] Future schema changes: `npm run db:generate`, review the SQL, then `npm run db:migrate` against the target database.

## 2b. Supabase Auth settings (dashboard → Authentication)

None of these can be set from the repo, and none were changed by this work. Check each:

| Where | Set | Why |
|---|---|---|
| URL Configuration → **Site URL** | `https://altrcam.vercel.app` (or your custom domain once it is live) | The base of links in Auth emails |
| URL Configuration → **Redirect URLs** | `https://altrcam.vercel.app/**` (plus each custom domain, and `http://localhost:3000/**` for local dev) | The app asks Supabase to send people back to `/auth/callback?next=…`; anything not on this list is replaced by the Site URL and the link lands on the home page instead of signing in |
| Providers → **Email** | enabled, **Confirm email** on | The app also refuses unconfirmed emails server-side (`/verify-email`), so turning confirmation off only skips the email |
| **SMTP Settings** | your provider (Resend works: host `smtp.resend.com`, port 465, user `resend`, password = an API key; sender on your verified domain) | Supabase's built-in sender is for testing: as far as I know it delivers only to your Supabase team's own addresses and only a few emails an hour (check the dashboard's notice). Real users won't get confirmation or reset emails without custom SMTP |
| Email Templates (optional) | Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email` · Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/settings/password` | The default `{{ .ConfirmationURL }}` links work (via `/auth/callback`) but sign you in only in the browser that asked; these `token_hash` links work from any device. Both styles are supported |
| Providers → **Google** (optional) | client ID/secret from Google Cloud; then set `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=true` in Vercel and redeploy | The Google button is hidden until that variable is `true`, so a disabled provider never shows a dead button |
| Rate limits | defaults are fine to start | Sign-up/sign-in and email limits are enforced by Supabase |

Accounts created before this fix (one confirmed user signed up today) have no `users` row yet; it is created on their next signed-in visit, with the signup credits.

## 3. Check locally

```bash
cd altrcam
cp .env.example .env.local        # fill in every value
npm install
npm run db:migrate                # schema + RLS + plan_config
npm run preflight                 # read-only check of everything above
```

`preflight` should print no `FAIL`. It checks: env validates, every table in the schema exists, RLS is on for each, the `uploads` bucket exists and is **private**, the Supabase secret key can list Auth users, both Paystack plans exist **and match your prices**, the NOWPayments key works, the Resend domain is verified, and Redis answers. It cannot check fal or webhook registration (sections 7 and 6).

Then make yourself the first admin: sign up in the running app (and confirm your email), then either run `npm run db:seed -- you@example.com` with the real variables in `.env.local`, or run this in the Supabase dashboard → SQL editor:

```sql
update auth.users
set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"role":"admin"}'::jsonb
where email = 'you@example.com';
```

Nobody is ever admin automatically. The role is Supabase `app_metadata.role = "admin"`: users can't change `app_metadata` themselves (only the secret key or SQL can), and the app reads it server-side through `auth.getUser()` on every admin request, so the change applies on your next page load; the Admin link then appears in the header. Remove it with `raw_app_meta_data - 'role'`.

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
| Crons | read from `altrcam/vercel.json`: monthly refill and daily retention only (both fine on Hobby). The **5-minute stale-session sweep is not a Vercel cron**: it runs from GitHub Actions, see section 4b. Check your plan allows the 300 s function limit set on the refill/retention routes |
| Domains | add `altrcam.com` and `altrcam.ai` (the app redirects `.ai` to `.com`) |
| Region | pick the one closest to your Supabase region |

**Environment variables:** add every variable above in *Settings → Environment Variables* (the Supabase ones come from the integration). Use **different values per environment**: Preview gets its own Supabase project and Paystack **test** keys; only Production gets live ones. `NEXT_PUBLIC_*` values are baked in at build time, so **redeploy after changing them** (including `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED`).

**Set the Supabase public keys for Production builds too.** The public pages read the signed-in state; a build without `NEXT_PUBLIC_SUPABASE_URL` and the publishable key bakes in the signed-out state for any page Next renders statically. With them set, every marketing page is dynamic (the layout reads the session).

The app builds and serves public pages even with none of them set. `GET /api/health` on the deployed URL shows which integrations it considers configured (booleans only), a quick way to see what's still missing.

## 4b. Turn on the stale-session sweep (GitHub Actions)

Vercel's Hobby plan only allows daily crons (Vercel's documented limit; not tried here), so `.github/workflows/altrcam-sweep.yml` calls `/api/cron/stale-sessions` every 5 minutes instead. The job is **skipped while `ALTRCAM_URL` is unset**. If you set the variable but not the secret, every run **fails red** with "CRON_SECRET is not set" (on purpose, so a half-finished setup is noticed). Set both:

- [ ] GitHub repo → Settings → Secrets and variables → Actions → **Variables**: `ALTRCAM_URL` = the https URL of the deployment (e.g. `https://altrcam.com`).
- [ ] Same page → **Secrets**: `CRON_SECRET` = exactly the value of `CRON_SECRET` in Vercel's Production environment.
- [ ] Actions tab → *AltrCam stale-session sweep* → **Run workflow** once. A green run logs `ok (HTTP 200): {"closed":N}`. A red run saying "rejected" means the secrets differ.
- [ ] Check the Actions tab again after ~15 minutes: a run with event `schedule` should have appeared. **This repo is a fork**, and I believe GitHub does not run scheduled workflows on forks until you enable them there. Not verified.
- Scheduled runs can be delayed or skipped under load (read "5 min" as roughly 5-15), and GitHub pauses schedules on a public repo after 60 days without activity. Billing does not depend on the sweep (heartbeats bill), but abandoned sessions stay open until it runs.
- **Nothing alerts you if the sweep silently stops** (job skipped, runs dropped, schedules disabled on the fork, the 60-day pause). Look at the Actions tab now and then. While it is not running, an abandoned session stays open (and can still mint fal tokens) until its owner starts a new one, which closes it billed only up to its last heartbeat (see `README_LIMITATIONS.md`).
- The same workflow can run `refill` or `retention` by hand if a Vercel cron ever misses a day.

## 5. Merge and deploy to a preview first
Push a branch or open a PR; Vercel builds a preview. Open it, check `/api/health`, then run sections 6-8 against the preview URL.

## 6. Register webhooks (use the preview URL while testing)

| Where | URL | Events |
|---|---|---|
| Paystack → Settings → API & Webhooks | `https://<domain>/api/webhooks/paystack` | all (the app handles `charge.success`, `subscription.create`, `subscription.disable`, `subscription.not_renew`, `invoice.payment_failed`) |
| NOWPayments → IPN | `https://<domain>/api/webhooks/nowpayments` | payment status |

A bad signature returns 401, so a wrong secret shows up as webhook deliveries failing with 401 in the provider's dashboard. Preview URLs are behind Vercel Authentication; either turn that off for the webhook paths' environment or test webhooks against a custom preview domain.

## 7. Verify fal signaling: the riskiest step
`lib/fal/signaling.ts` sends an SDP offer over the `@fal-ai/client` realtime socket, applies the answer, trickles ICE candidates both ways and plays the remote track, but **the message names were written without fal's spec**. It uses the client's default message serialization, as fal's documented `fal.realtime.connect(...).send(obj)` usage does. Verify against the real service before anything else.

**The order of messages matters, not only their names.** The pinned client opens no socket until our first send, so the code sends the offer first, never waits for a server message, and holds ICE candidates in its own queue until the server's first reply of any type (details and what the fakes prove: `README_LIMITATIONS.md`). If the real service behaves differently, for example it wants something before the offer or waits for candidates before it answers, changing the names will not be enough; the sequence in `connectLucy` (and `ICE_SERVERS`: server-provided TURN servers are not used) changes too.

1. Sign in on the preview, open `/studio`, allow the camera. The page shows a "not been tested against the real AI service" notice and "video only" note; that is expected.
2. DevTools → Network. Click **Go live**.
3. `POST /api/fal/proxy` should return **200** (the short-lived token, a JSON string or plain text). 403 = no active studio session (check `/api/studio/session/start`); 400 = see the guard in `app/api/fal/proxy/route.ts`. The Studio reports a refused token at once ("...wouldn't allow the video connection...") instead of waiting 20 s.
4. Filter Network by **WS**; open the `wss://fal.run/decart/lucy-2-5/...` connection → **Messages**. The first frame we send is the `offer`; ICE candidates follow only after the first frame fal sends. Compare every frame with the `Incoming` / `Outgoing` types in `signaling.ts`: what does fal send first, and under what field names? What does it expect in the offer, and what does the answer look like? Are frames binary (msgpack, the client default) or JSON text? If fal expects JSON text, add `encodeMessage`/`decodeMessage` options to `connect`. Does it ever send ICE servers, and do users need them (see the TURN note above)?
5. If names differ, edit `Outgoing`, `Incoming` and `handleIncoming`; if the sequence differs, edit `connectLucy`. Then run `npx vitest run tests/unit/signaling.test.ts tests/unit/signaling-real-client.test.ts`: the ordering and teardown tests will tell you what you broke, but they only fake fal, so a pass proves nothing about the live service.
6. **Success:** Connecting → Live within a few seconds, the right-hand video plays the transformed feed, the credit counter ticks down once a second, and the dashboard balance drops after a heartbeat (every 10 s).
7. **Failure path (do this too):** with a wrong prompt field, or with the network blocked after the offer, the Studio should end up on **Failed** with a plain-language reason and a **Reconnect** button, heartbeats should stop, and the session should show `end_reason = connection_failed` in Admin. A failed attempt is billed for the time it was open.

| Symptom | Likely cause |
|---|---|
| **Failed**, "The AI service didn't answer within 20 seconds" | no answer at all: wrong message names or offer fields, a sequence the service doesn't accept, or a server `Unauthorized` that the client swallows |
| **Failed**, "Your browser couldn't set up a direct video connection" after about 30 s, and the answer did arrive | the answer was applied but ICE never connected: NAT, firewall or VPN, and no TURN server is used (the offer is made before the service can send its `ice_servers`) |
| **Failed**, "The AI service reported an error: ..." | the service rejected the offer; the text is its own |
| **Failed**, "...wouldn't allow the video connection because this session is no longer open" (403) | no active session: the `x-altrcam-session` header is missing/invalid, or the session already ended (credits, plan limit, sweep) |
| **Failed**, "Couldn't get permission for the video connection..." | the token request got no usable answer: network, a 5xx from `/api/fal/proxy`, or a token response the code can't read |
| **Failed**, "...couldn't set up a direct video connection" | ICE failed: firewall/VPN, or the service needs TURN servers we don't use |
| **Failed**, "The AI service replied, but its reply couldn't be used" | the answer's SDP field name differs from `answer.sdp` |
| Connects, no video | answer applied but no `ontrack`: codecs/transceivers in the offer |
| Sign-in fails with a CSP error in the console | the browser talks to `NEXT_PUBLIC_SUPABASE_URL`; `*.supabase.co` is allowed, and a custom Auth domain is added to `connect-src` automatically from that variable at build time, so redeploy after changing it |

Also compare what fal actually **bills** for that session against the credits the app deducted.

### Unverified background facts (leads for step 4, not answers)
None of these was read from fal's or Decart's documentation, and none was used to change a name or option in the code. They come from public search-result snippets seen while building this, so check them before relying on any:
- fal's own realtime example calls `fal.realtime.connect` with `onResult`, `onError` and a `tokenProvider` that POSTs to the app's backend and returns the token as plain text, uses `tokenExpirationSeconds` of 10, and ends with `connection.send({})`.
- fal's guide lists $0.04 per second of processed video (see section 1).
- Decart's own direct (non-fal) API uses an `ice-candidate` message type and an `answer` type with an `sdp` field. If fal's schema turns out to differ from ours (`ice_candidate`, `answer`), this is a lead on what to try.

**When a real session has worked, update what the public pages say.** Until then the landing page, `/how-it-works`, `/pricing`, the FAQ and `/billing` tell visitors that live video has not been tested end to end and may not connect (`lib/availability.ts`; one wording, shown in all five places), and the site's meta description and hero say the product is "built to" restyle video rather than that it does. After you have run and checked a session, replace that wording with what you actually tested, or remove the `AvailabilityNotice` uses and the FAQ entry "Does the live video work yet?", and un-hedge the hero and `app/layout.tsx`. Do not leave "not tested" up after it has been, and do not take it down before. **Tests will fail when you do, on purpose:** they assert the notice (search for `LIVE_AVAILABILITY` and `live-availability` in `tests/unit/public-copy.test.ts`, `tests/unit/public-pages.test.ts` and `tests/public/site.spec.ts`); update them to the new wording in the same change.

## 8. End-to-end test (test mode)
- [ ] **Email + password sign-up**: you land on "Confirm your email"; the confirmation email arrives (check spam; see SMTP in 2b); its link signs you in on `/dashboard`, where a `users` row exists with your FREE allowance (`signup_grant` in `credit_ledger`). Opening the link on another device confirms the address and asks you to sign in.
- [ ] **Forgot password** on `/sign-in`: the email's link lands on `/settings/password`; the new password works and the old one doesn't.
- [ ] **Sign out** from the header, then `/dashboard` sends you to `/sign-in`.
- [ ] **Google** (only if you enabled it, 2b): "Continue with Google" shows, and lands on `/dashboard` with a `users` row.
- [ ] **Studio**: go live, credits count down, Stop ends the session (`studio_sessions.ended_at` set, `seconds_billed` ≈ what you watched).
- [ ] **Studio failure path**: break the connection on purpose (block the WebSocket in DevTools, or go offline after Go live). The page shows **Failed** with a reason, heartbeats stop, the session is closed (`end_reason = connection_failed`), and **Reconnect** starts a new session. Check what a failed attempt cost against what the page warned.
- [ ] **Camera**: block camera access for the site; the Studio explains it and **Retry camera** works once you allow it. Unplug or disable the camera mid-session (a real device, not a simulation); the session ends (`end_reason = camera_lost`).
- [ ] **Cut-off at zero**: as admin, revoke credits down to ~15, go live, confirm the session stops by itself and `/studio` then says "out of credits".
- [ ] **Close the tab mid-session**: within ~5-15 min the GitHub Actions stale sweep (section 4b) closes it (`end_reason = stale`).
- [ ] **Pay with Paystack (test card)**: success page confirms; `payments` row `success`; plan PRO; credits reset to the Pro allowance; receipt email.
- [ ] **Replay that webhook** from Paystack's dashboard: balance does **not** change again.
- [ ] **Top-up** lands in the purchased bucket and survives a monthly refill.
- [ ] **Cancel subscription**: plan stays PRO until period end, then the daily retention cron downgrades it (after a 2-day grace).
- [ ] **Crypto** (if enabled): sandbox payment reaches `finished` and unlocks; `partially_paid` only notifies.
- [ ] **Snapshot** appears in History with a thumbnail; **Record clip** downloads (Pro).
- [ ] **Admin**: grant/revoke credits, change a user's plan, edit **Plans** limits; all appear in the audit log.
- [ ] **Delete account**: the Supabase Auth user (Authentication → Users), files and rows are gone; payments remain, anonymised; signing in again fails.
- [ ] **Public pages** render: `/how-it-works`, `/faq`, `/terms`, `/privacy`, `/contact`, a bad URL (branded 404), `/robots.txt`, `/sitemap.xml`.

## 9. Before switching to live money
- [ ] **Custom SMTP** in Supabase Auth (the built-in sender is rate-limited and not for production), **live** Paystack keys, all webhooks re-registered with the live secrets.
- [ ] A lawyer has reviewed `/terms` and `/privacy` (they are templates, marked as such on the page) and you've decided your refund policy. The Terms currently say payments are non-refundable except where the law requires.
- [ ] Remove the "Template text" banner from those pages only after that review.
- [ ] Prices approved → `PRICING_APPROVED=true`; allowances set from the real provider cost (section 1).
- [ ] `NEXT_PUBLIC_SUPPORT_EMAIL` is a monitored inbox.
- [ ] Keys live only in Vercel env (never committed); rotate anything ever pasted into a chat or ticket.
- [ ] Optional: set repo variable `E2E_ENABLED=true` so CI also runs the local-Supabase Playwright suite (`npm run test:e2e:local`; Docker on the runner, no secrets needed).
- [ ] Watch the first real payment end to end, and the first real session's cost in the fal dashboard.

## Known limits
See `README_LIMITATIONS.md`. In particular: a modified client can keep an open fal connection for up to ~2 minutes after the server stops billing, and a user can get up to ~10 s per session unbilled.
