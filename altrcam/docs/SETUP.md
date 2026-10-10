# Setup: environment variables and dashboards

What to set in Vercel and in the Clerk Dashboard for accounts to work, and how the sign-up switch interacts with the build.
The ordered launch checklist (services, database, prices, payment webhooks, end-to-end test) is [`GO_LIVE.md`](../GO_LIVE.md);
this file covers the configuration it refers to and does not repeat it.

## The sign-up switch (`SIGNUPS_OPEN`)

Sign-up is opened by **one explicit switch**, not by credentials happening to be present.

| Variable | Values | Default |
|---|---|---|
| `SIGNUPS_OPEN` | `true` or `false` | `false` (unset or empty counts as `false`) |

Sign-up is open (`accountsOpen()` in `lib/config.ts`) only when **all** of these hold:

1. `SIGNUPS_OPEN` is exactly `true` (`TRUE`, `yes` or `1` do not count: a typo can only keep sign-up closed);
2. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` are both set;
3. `DATABASE_URL` is set.

Every public page asks this one function: the landing page, `/how-it-works`, `/pricing`, the header and `/sign-up`. When it is
false they say "Sign-up isn't open yet" and show no sign-up button. `/sign-in` needs only 2 and 3, so switching sign-up off never
locks existing accounts out. `GET /api/health` reports the result as `capabilities.signups` (a boolean, no values).

### What the build checks

| Build | `SIGNUPS_OPEN` | Credentials | Result |
|---|---|---|---|
| Vercel **Production** (`VERCEL_ENV=production`) | `true` | all three set | builds; sign-up is open |
| Vercel **Production** | `true` | any missing | **build fails**, naming the missing variables |
| Vercel **Production** | anything other than `true`/`false` | any | **build fails** ("must be exactly true or false") |
| Vercel **Production** | unset or `false` | any, including none | builds; sign-up stays closed |
| Preview, local, CI | any | any | builds (never failed by this check) |

The check is `lib/build-check.ts`, run from `next.config.ts` only while `next build` runs (unit-tested in
`tests/unit/build-check.test.ts`). The failure looks like:

```
[altrcam] SIGNUPS_OPEN=true, but this Production build is missing CLERK_SECRET_KEY. Sign-up needs both Clerk keys and DATABASE_URL. ...
```

**Deliberately, an unset or `false` switch never fails the build.** Production has no credentials today; failing every build
that lacks them would block every deploy, including fixes to the public pages. Instead the site stays explicitly closed. The
order to open sign-up is therefore: set the Clerk keys and `DATABASE_URL` for Production, set `SIGNUPS_OPEN=true`, redeploy.
Environment variable changes only take effect on the next deployment.

**The switch hides our sign-up UI; it does not stop Clerk.** Once the Clerk keys are set, Clerk's own API accepts sign-ups
from anyone holding the publishable key (which is public), whatever `SIGNUPS_OPEN` says, and the `user.created` webhook then
gives that account its free credits. To really close sign-up while Clerk is configured, also set the Clerk Dashboard's sign-up
mode (the **Access mode** page; older dashboards: **Restrictions**) to **Invite-only/Restricted** or **Waitlist**, and back to
**Open/Public** when you open. (Clerk renamed these pages; check the labels in your dashboard. Not verified against a real instance.)

## Environment variables (Vercel → Settings → Environment Variables)

Every variable the code reads, from `lib/env.ts` (the production schema, checked at boot by `instrumentation.ts` and by
`npm run preflight`), `lib/config.ts`, `scripts/preflight.ts` and the rest of the code. **Secret** means: never commit it, never put it
in a `NEXT_PUBLIC_` variable, rotate it if it was ever pasted somewhere. `NEXT_PUBLIC_*` values are compiled into the browser bundle
at build time, so they are public by definition and **a change needs a redeploy** (so does any change, in practice: Vercel applies
environment variables to new deployments only).

Use **different values for Production and Preview**: Preview gets the Clerk *development* instance, Paystack *test* keys and a
separate database; only Production gets live keys and the production database (see GO_LIVE.md section 2, "The database").

### Accounts (this is what sign-up needs)

| Variable | Secret? | Production | Preview | Where the value comes from |
|---|---|---|---|---|
| `SIGNUPS_OPEN` | no | `false` until you open, then `true` | `true` to test sign-up | your decision; see "The sign-up switch" above |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | no (public) | `pk_live_…` | `pk_test_…` | Clerk Dashboard → (instance) → **API keys** |
| `CLERK_SECRET_KEY` | **secret** | `sk_live_…` | `sk_test_…` | same page |
| `CLERK_WEBHOOK_SECRET` | **secret** | `whsec_…` of the production endpoint | `whsec_…` of the preview endpoint | Clerk Dashboard → **Webhooks** → your endpoint → **Signing secret** |
| `DATABASE_URL` | **secret** | production Supabase, *Transaction pooler* (port 6543) | a separate Supabase project | Supabase → **Connect** → Transaction pooler (with the database password) |

Without both Clerk keys every page still works and protected routes answer 503 ("Sign-in is not configured"). Without
`CLERK_WEBHOOK_SECRET` the webhook answers 401 to everything; accounts are then created by the lazy path on the first signed-in
page instead, so sign-up still works, but profile changes and Clerk-side deletions are not synced.

### Everything else the app reads

| Variable | Secret? | Needed for | Where it comes from |
|---|---|---|---|
| `NEXT_PUBLIC_APP_URL` | no | links in emails, payment callback URLs, metadata, sitemap | the deployment's https URL, e.g. `https://altrcam.com` (Preview: the preview URL) |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | no | the Contact page (default `support@altrcam.com`) | an inbox someone reads |
| `SUPABASE_URL` | no (server only) | Storage (snapshots, reference images) | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | **secret** | Storage | Supabase → Settings → API → `service_role` |
| `FAL_KEY` | **secret** | the live video (server proxy only) | fal.ai → API keys |
| `PAYSTACK_SECRET_KEY` | **secret** | card checkout, Paystack webhook signature | Paystack → Settings → API Keys & Webhooks |
| `PAYSTACK_PUBLIC_KEY` | no | required by the env schema | same page |
| `PAYSTACK_PLAN_PRO_MONTHLY`, `PAYSTACK_PLAN_PRO_YEARLY` | no | Pro subscriptions | Paystack → Plans (codes `PLN_…`) |
| `NOWPAYMENTS_API_KEY`, `NOWPAYMENTS_IPN_SECRET` | **secret** | crypto checkout (optional) | NOWPayments → Settings |
| `RESEND_API_KEY` | **secret** | receipts, low-credit and ticket emails | Resend → API Keys |
| `EMAIL_FROM` | no | sender (default `AltrCam <hello@altrcam.com>`) | a verified Resend domain |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | token **secret** | rate limiting (production refuses rate-limited routes without it) | Upstash → Redis → REST API |
| `CRON_SECRET` | **secret** | the cron routes (≥16 characters) | `openssl rand -hex 24`; the same value as the GitHub secret (GO_LIVE.md 4b) |
| `PRICE_CURRENCY`, `PRICE_PRO_MONTHLY`, `PRICE_PRO_YEARLY`, `PRICE_LIFETIME`, `PRICE_TOPUP_1K`, `PRICE_TOPUP_5K`, `PRICE_TOPUP_15K`, `PRICING_APPROVED` | no | prices (minor units) and the "not final" notice | your pricing decision (GO_LIVE.md section 1) |

**Other streams of work will add pricing and billing variables here**; this table is where they belong.

Do **not** set:
- `PAYSTACK_API_URL` (only the e2e test points it at a local mock);
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`,
  `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`: these are set in code (`AUTH_URLS` in `lib/routes.ts`), which wins over them;
- `NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_FORCE_REDIRECT_URL`,
  `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL`: the code doesn't set them, and if set they change
  where people land after signing in.

Set by the platform, not by you: `VERCEL_ENV` (the build check reads it), `NODE_ENV`, `NEXT_RUNTIME`.
Outside Vercel: GitHub Actions uses the variable `ALTRCAM_URL` and the secret `CRON_SECRET` (GO_LIVE.md 4b), and optionally
`E2E_ENABLED` with `CLERK_TEST_PUBLISHABLE_KEY` / `CLERK_TEST_SECRET_KEY`; `TEST_DATABASE_URL` is only for
`npm run test:integration` on your machine or in CI.

Check what a deployment considers configured with `GET /api/health` (booleans only, never values): `capabilities.signups` is
`true` only when sign-up is really open.

## Clerk Dashboard

These are settings in Clerk, not code; the app only renders Clerk's `<SignIn />`, `<SignUp />` and `<UserProfile />` (on
`/settings`). Configure them on **both** instances (development for Preview, production for Production): settings do not copy
from development to production.

**Production needs a domain you own.** Clerk does not allow a `*.vercel.app` domain for a production instance, so live keys will
not work on `altrcam.vercel.app`; add `altrcam.com` (Clerk → **Domains**, plus the DNS records it asks for, which create
`clerk.altrcam.com`) and serve Production from it. Until then, only a development instance works, with its banner and limits.

### Sign-in methods (User & authentication)
- **Email address**: on, required, *verify at sign-up* with an email code or link.
- **Password**: on. Password reset ("Forgot password?") is offered by Clerk's sign-in form once passwords and email are on.
- **Google** and **GitHub** (Social connections / SSO connections): on. The development instance can use Clerk's shared OAuth
  credentials; the **production instance needs your own** OAuth app for each (Google Cloud console, GitHub → Developer settings),
  with the redirect URI Clerk shows you.
- **Multi-factor**: enable **Authenticator application (TOTP)** and leave it optional; users turn it on in Settings (the
  `<UserProfile />` there shows it). Optionally also enable **Backup codes**.
- **Sign-up mode** (the **Access mode** page; older dashboards call it **Restrictions**): **Open/Public** when `SIGNUPS_OPEN=true`;
  **Invite-only/Restricted** or **Waitlist** while you keep sign-up closed but the keys are set (see the warning in "The sign-up switch").

### Paths and redirects
- The code sets: sign-in `/sign-in`, sign-up `/sign-up`, and `/dashboard` after signing in or up (unless Clerk was sent there with
  a `redirect_url`, e.g. from a protected page). In Clerk → **Paths** (if your dashboard shows that page), set *Sign-in* and *Sign-up* to "on application domain" at
  `/sign-in` and `/sign-up`, so emails and Clerk-hosted flows come back to these pages rather than the Account Portal.
- Allowed origins / redirect origins: nothing to add when the app runs on the production domain (or its subdomains) and Preview
  uses the development instance. Clerk only needs extra allowed origins (instance setting `allowed_origins`, set through Clerk's
  Backend API) for requests from other origins, which this app doesn't make. Optional hardening not done in code: `authorizedParties`
  on `clerkMiddleware` (Clerk recommends it in production; it would need every origin you serve, including preview URLs).

### Webhook
- Clerk → **Webhooks** → **Add endpoint**: `https://<domain>/api/webhooks/clerk` (Production: `https://altrcam.com/...`; a Preview
  needs its own endpoint on the development instance, and Vercel Authentication must not block that path).
- Events: `user.created`, `user.updated`, `user.deleted`.
- Copy the endpoint's **Signing secret** into `CLERK_WEBHOOK_SECRET` for that environment and redeploy.
- What it does: `user.created` creates the account row on the Free plan with the sign-up credits and records the delivery
  (`clerk:<svix-id>` in `webhook_events`, visible in Admin), so a replay changes nothing; `user.updated` syncs name, email and
  avatar; `user.deleted` deletes the account's data. A wrong secret shows in Clerk's webhook log as **401** responses.

### Admin
Make yourself admin after your first sign-up: `npm run db:seed -- you@example.com` (sets Clerk `publicMetadata.role = "admin"`).

## Order of operations

The full go-live checklist (services, database, prices, webhooks for Paystack and NOWPayments, the end-to-end test) is
[`GO_LIVE.md`](../GO_LIVE.md); this file does not repeat it. For accounts specifically:

1. Preview: set the development Clerk keys, a preview `DATABASE_URL`, `CLERK_WEBHOOK_SECRET` and `SIGNUPS_OPEN=true` for Preview;
   deploy a preview and sign up with email, Google and GitHub (GO_LIVE.md section 8).
2. Production: add the domain to Clerk's production instance, set the live keys, `DATABASE_URL` and `CLERK_WEBHOOK_SECRET` for
   Production, register the production webhook, keep `SIGNUPS_OPEN=false` and Clerk's sign-up mode restricted, deploy. Create
   your own account from the Clerk Dashboard (Users → create or invite), sign in at `/sign-in` (it works while sign-up is
   switched off), make yourself admin, and check `/api/health`.
3. Open: set `SIGNUPS_OPEN=true` and Clerk's sign-up mode to Open, redeploy. If a credential is missing the build fails and names it.
