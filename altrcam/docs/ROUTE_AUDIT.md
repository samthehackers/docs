# Route audit (Supabase Auth on `main`)

Every existing route was read together with what it calls (queries, API routes, components) and checked against the
production environment as it is today: Supabase integration variables only (`NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_*`,
`POSTGRES_*`), and **no** `DATABASE_URL`, `FAL_KEY`, Paystack, NOWPayments, Resend, Upstash or `CRON_SECRET`.
UI and route structure were kept; fixes are the smallest change that makes the route work.

**Before** means `main` at the start of this work, in that production environment.

Two defects broke every signed-in route at once, so they are not repeated in each row:

- **D1:** `lib/db.ts` read only `DATABASE_URL`, so every signed-in page threw "DATABASE_URL is not set" (and no `users`
  row was ever created). The raw `POSTGRES_URL` would also have failed: postgres.js forwards its `supa=base-pooler.x`
  parameter to the server, which refuses it with `unrecognized configuration parameter "supa"` (reproduced locally).
  Fixed by `lib/database-url.ts`: `DATABASE_URL ?? POSTGRES_URL ?? POSTGRES_PRISMA_URL`, unknown parameters stripped,
  `sslmode` kept, TLS forced for Supabase hosts, `prepare:false`. Migrations prefer `POSTGRES_URL_NON_POOLING`.
- **D2:** `lib/ratelimit.ts` threw "Rate limiter not configured" in production without Upstash, so every route that
  rate-limits answered 500: support tickets, Studio session start and heartbeat, uploads, checkout. Fixed with an
  in-memory per-instance fallback.

Evidence key: **E** = `tests/e2e/supabase-local.spec.ts` (real local Supabase Auth + Postgres + Mailpit, Chromium,
integration env names, no optional keys); **I** = `tests/integration/*.pg.test.ts` (real PostgreSQL, production driver);
**U** = `tests/unit/*`; **P** = `tests/public/site.spec.ts` (no credentials, Chromium).

## Public

| route | access rule | data it shows | status before | what you fixed | evidence |
|---|---|---|---|---|---|
| `/` | public; signed-in visitors see "Open the studio" | plan limits (`getPlans`, falls back to defaults), live-video notice, sign-up state from `accountsOpen()` | worked (`accountsOpen` already counted `POSTGRES_URL`) | `viewerId` no longer calls Auth when it isn't configured; hedged meta description restored (v0 had shortened it; tests require it) | U public-pages, P |
| `/pricing` | public | plan cards from `getPlans`, checkout state from `paymentsOpen()` ("Checkout isn't open" with no provider) | worked | none beyond the shared ones | U public-pages, P |
| `/sign-up` | public | email/password form; Google button | form worked; the Google button was always shown (dead while the provider is off); no "accounts closed" state any more | Google button only when `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED=true`; "account access is not configured" notice restored when Auth/DB are missing; after sign-up without a session → `/verify-email` | U public-pages, E |
| `/sign-in` | public | email/password form, "Forgot password?", Google button | sign-in worked; the reset link pointed at a page that didn't exist; an unconfirmed account got a raw error; failed auth links had nowhere to land | `?error=` codes shown as a friendly message; unconfirmed → `/verify-email`; reset link now lands on a real page; Google gated as above | U auth-routes, E |
| `/verify-email` (new, minimal) | public; signed-in confirmed users are sent to `/dashboard` | "Confirm your email" + resend (`auth.resend`) | did not exist | added in the auth-form style | E (resend, redirect) |
| `/auth/callback` | public (it creates the session) | none (redirect) | **open redirect** (`next=//evil.com` passed `startsWith("/")`); `error`/`error_description` and failed code exchanges ignored, so users bounced to `/dashboard` → `/sign-in` with no explanation; crashed without Auth configured | `safeNextPath` (rejects `//`, `/\`, encoded variants, schemes, control chars); errors → `/sign-in?error=<code>`; a link opened in another browser says the email is confirmed and to sign in; 307 to sign-in when Auth isn't configured | U auth-routes (36 cases), E, P |
| `/auth/confirm` (new) | public | none (redirect) | did not exist (only PKCE-style email templates worked) | `token_hash` + `type` via `verifyOtp`; recovery defaults to `/settings/password`; same `next` validation | U auth-routes |
| `/auth/sign-out` (new, POST) | same-origin POST | none (303 to `/`) | sign-out was a client-only button; clicked before hydration (right after a navigation) it did nothing (seen in E) | the header button is now a form POST to this route (server `signOut`, cookies cleared); same UI | E |

## Signed in

Access rule for all of these: `middleware.ts` sends signed-out visitors to `/sign-in` (APIs: 401 JSON; before, the
unanchored `"/"` pattern matched every path, so the middleware never redirected and only the pages' own checks did), then
the `(app)` layout and each page call `requireAppUser()`: `supabase.auth.getUser()` (verified with the Auth server),
**email must be confirmed** (else `/verify-email`; APIs answer 403 `email_unconfirmed`), then `ensureUserRow` creates the
`users` row and signup credits on the first visit. Every query below is filtered on that server-verified id. With Auth
or the database unconfigured, the middleware answers 503 with the reason instead of a crash.

| route | access rule | data it shows | status before | what you fixed | evidence |
|---|---|---|---|---|---|
| `/dashboard` | signed in, confirmed | profile, ledger balance (monthly/purchased), usage this month, sessions, plan status, last payment, presets, recent snapshots, usage history (`lib/queries.ts`) | 500 (D1) | D1 | E (balance on screen = `sum(credit_ledger.delta)`), U dashboard-data, I |
| `/studio` | signed in, confirmed; out-of-credits gate | balance, own presets, `?reuse=` only the user's own transformation, plan resolution/clip rights | 500 (D1); without `FAL_KEY` it only said so after Go live; Go live itself 500 (D2); `/api/fal/proxy` imported Clerk `auth()` so a token could never be minted | D1, D2; up-front "Live video isn't configured" notice when `FAL_KEY` is missing (Go live answers 503 before any session is opened or billed); fal proxy uses `requireUserId` | E (notice, 503, no session row, another user's `?reuse=` ignored), U session-billing, isolation, studio-* |
| `/history` | signed in, confirmed | own snapshots in the plan's retention window, filters, pagination, signed thumbnail URLs | 500 (D1); a storage error while signing a thumbnail would 500 the page | D1; thumbnail failure shows a blank tile | E (other user's still never shown; DELETE of it → 404) |
| `/presets` | signed in, confirmed | own presets, plan cap | 500 (D1) | D1 | E (create + list), U isolation |
| `/settings` (+ `/settings/[[...rest]]`) | signed in, confirmed | email, name, notification toggle, delete account | 500 (D1); account deletion called Clerk's `clerkClient()`, which failed (only logged), so the login was never removed and the person could sign back in to an empty account | D1; deletion removes the Supabase Auth user with a server-only admin client (`SUPABASE_SECRET_KEY` ?? `SUPABASE_SERVICE_ROLE_KEY`) after the same data-deletion order, then signs the browser out; "Change password" link | E (renders; delete account removes the rows and the Supabase Auth user, and sign-in then fails), U isolation, I delete-account |
| `/settings/password` (new, minimal) | signed in (normal or recovery session), confirmed | new password + confirm; loading/error/success | the reset email's link went to `/settings/password`, which rendered the ordinary Settings page (no way to set a password) | page added in the Settings card style; `updateUser({ password })` | E (reset by email, old password refused, new one works) |
| `/billing` | signed in, confirmed | plan, active subscription, own payment history, checkout buttons | 500 (D1); with no payment keys checkout would 500 (D2) | D1, D2; checkout answers 503 "Payments aren't available yet. Nothing was charged."; notice wording no longer claims the buttons are disabled | E (notice, 503) |
| `/billing/success` | signed in, confirmed | polls `/api/payments/status` for the user's own reference | 500 (D1) | D1 | E (renders) , U isolation (status is read-only and own-only) |
| `/support` | signed in, confirmed | troubleshooting, ticket form, own tickets + admin replies | 500 (D1); sending a ticket 500 (D2) | D1, D2; tickets are stored without Resend (email is only for admin replies and is skipped when unset) | E (ticket stored and listed) |
| `/referrals` | signed in, confirmed | own referral code/link, stats | 500 (D1); link used `NEXT_PUBLIC_APP_URL ?? "https://altrcam.com"` (unset in production) | D1; link base is `NEXT_PUBLIC_APP_URL`, else Vercel's `VERCEL_PROJECT_PRODUCTION_URL` (same for payment return URLs, emails, sitemap) | E (link ends `?ref=<code from DB>`), U referrals, I |

## Admin

| route | access rule | data it shows | status before | what you fixed | evidence |
|---|---|---|---|---|---|
| `/admin` (all tabs) | signed in, confirmed, `app_metadata.role === "admin"`; checked in the layout, in the page and inside every `lib/admin.ts` data function (`requireAdminPage`) | KPIs, user search/detail, plan limits, payments, sessions, tickets, webhooks, audit | 500 (D1) | D1. Role source unchanged (`app_metadata` is writable only with the secret key or SQL); `docs`/`GO_LIVE.md` now say how to grant it | E (normal user → `/dashboard`, admin via `app_metadata` gets in and finds a user), U admin-gate |
| `/api/admin/*` (`credits`, `plan`, `plan-limits`, `tickets`, `users`) | `requireAdminId()` in every handler | n/a | 500 (D1) | D1. Checked: the actor id always comes from the server session; the target `userId` in the body is the admin's choice by design and is validated to exist | E (403 for a normal user, 200 for the admin), U isolation (role can't be smuggled in the body) |

## Other API routes used by the pages

| route | access rule | status before | what you fixed | evidence |
|---|---|---|---|---|
| `/api/studio/session/{start,heartbeat,end}`, `/api/studio/{upload,snapshot}` | `requireUserId`; own sessions/paths only | start/heartbeat/upload 500 (D2); missing storage config → 500 | D2; storage missing → 503 with a reason | E, U isolation, session-end-route |
| `/api/fal/proxy` | `requireUserId` + an open session of that user | Clerk `auth()` → threw | Supabase `requireUserId` | U, build |
| `/api/presets`, `/api/presets/[id]`, `/api/history/[id]`, `/api/notifications`, `/api/account`, `/api/support` | `requireUserId`; every write filtered on the user id | support 500 (D2) | D2 | E, U isolation |
| `/api/payments/{checkout,status,cancel}` | `requireUserId` | checkout 500 (D2) | D2 | E (503 with no keys), U isolation |
| `/api/webhooks/{paystack,nowpayments}` | signature; 401 when the secret is unset | worked | none | P, U signatures |
| `/api/webhooks/clerk` | — | dead (no Clerk) | removed | P (no longer listed) |
| `/api/cron/*` | `CRON_SECRET`; 401 when unset | worked (unset in production, so Vercel's crons get 401) | none | U cron-auth |
| `/api/health` | public; booleans only | reported a Clerk `webhooks` capability | capability removed | P |

## Not changed, still needs the owner

See `GO_LIVE.md` section 2b and the final report: Supabase Auth Site URL and redirect URLs, custom SMTP, optional
`token_hash` email templates, the Google provider plus `NEXT_PUBLIC_AUTH_GOOGLE_ENABLED`, `FAL_KEY`, payment keys,
Resend, Upstash, `CRON_SECRET`, and granting the first admin.
