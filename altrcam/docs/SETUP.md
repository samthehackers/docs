# Setup: environment variables and dashboards

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
gives that account its free credits. To really close sign-up while Clerk is configured, also set Clerk Dashboard →
**Configure → Restrictions → Sign-up mode** to **Restricted** (or Waitlist), and set it back to **Public** when you open.
