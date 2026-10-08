# Limitations & honest status

## Not verified against real services
This was built in a sandbox with no network access to fal.ai, Clerk, Supabase, Paystack, NOWPayments, Resend or Upstash. What that means concretely:

- **fal WebRTC signaling is unverified (highest risk).** `lib/fal/signaling.ts` implements the sequence *ICE servers → offer → answer → trickled ICE → remote track* over fal's realtime socket, but the JSON message names/fields (`ice_servers`, `offer`, `answer`, `ice_candidate`, `error`, and the offer's `prompt` / `enable_prompt_expansion` / `reference_image_url`) are my best reading, **not fal's published schema**. If fal differs, only the `Outgoing` / `Incoming` types and `handleIncoming` in that one file need changing. Nothing in the studio has been run against the live model. Treat the first real session as the integration test.
- The Clerk, Supabase Storage (signed-upload via `PUT` multipart), Resend and Upstash paths compile and are unit-tested only where they touch our own logic. They have not been run end to end.
- The Playwright e2e is written but **has not been executed** (it needs a Clerk dev instance and Postgres). Unit tests, typecheck, lint and `next build` pass.
- Paystack `GET /transaction/verify` and NOWPayments `GET /payment/:id` response shapes follow their public docs from memory; confirm in test mode.

## What the Lucy realtime API can and cannot do here
- Inputs exposed in the UI: `prompt`, `enable_prompt_expansion`, `reference_image_url`. There is **no** control for anything else. `image_url` is not exposed because its semantics aren't confirmed.
- Inputs are sent with the offer. "Apply changes" therefore **re-negotiates the stream** (brief interruption) rather than changing the prompt mid-stream. Whether the model supports live prompt updates is unknown.
- "Resolution" on the plan limits the **camera capture** size (640×360 vs 1280×720). Output resolution/FPS is decided by the model.
- Background swap, outfit and style are prompt (± reference image) presets, not separate model features.
- The fal realtime socket connects **directly** to fal using a short-lived token. Our proxy can only gate the token mint (and refresh), not the media. A tampered client that ignores `continue:false` could keep an already-open connection until fal expires its token (~2 min, since refresh is refused for closed sessions). Server-side billing still stops at zero credits and the stale sweep closes the session record.

## Billing & product gaps
- Stale sessions are billed to the last heartbeat, so a user who kills the tab right before a heartbeat can get up to ~10 s unbilled per session.
- "Receipts" are an email plus the payment reference in Billing. There are no PDF invoices.
- Crypto has no recurring billing; it is offered for Lifetime and top-ups. NOWPayments fiat price currency support (e.g. NGN) depends on your account; USD is the safe choice.
- Paystack renewals arrive as `charge.success` with no pending row; they are resolved by plan code → product and the customer's email → user. The Paystack plan amount must equal `PRICE_PRO_*` or renewals are recorded as `rejected`.
- Downgrade is "cancel at period end"; there is no proration or in-place plan switching (monthly ↔ yearly is a new checkout).
- `users.referral_code` / `referred_by` exist in the schema but there is no referral feature yet.
- Rate limiting is a no-op in development when Upstash isn't configured; in production a missing limiter errors loudly.
- The CSP allows `'unsafe-inline'` scripts (Clerk and Next inline bootstraps). Tightening to nonces is future work.
- Unauthenticated requests to protected pages return Clerk's default (redirect to sign-in in a browser; 404 for non-HTML clients).
