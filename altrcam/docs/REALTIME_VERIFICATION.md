# Realtime verification

AltrCam's live video depends on one thing nobody has seen work yet: the WebRTC connection to fal's Lucy 2.5 realtime app
(`decart/lucy-2-5/realtime`). The signaling in `lib/fal/signaling.ts` was written without fal's spec and **has never been run
against the real service** (see `README_LIMITATIONS.md`). This page is how you check it, what counts as a pass, and where the
result is recorded.

**Status: Not yet run against production.** A real run needs a deployment with `FAL_KEY` set, an admin account on it, and a
browser with network access to fal. None of that was available where this tool was built, so no result below is filled in
and nothing here should be read as evidence that the connection works.

## What the check does

`/admin/diagnostics` (admin only; linked from the admin console) runs one realtime session from your browser, using the
Studio's own connection code (`connectLucy`) unchanged:

1. Starts a **synthetic camera**: an animated `<canvas>` (a head-and-shoulders figure, moving shapes, a frame counter)
   captured with `canvas.captureStream(30)`. No real camera or permission is needed, so it also runs headless.
2. Gets a **diagnostics session** from `POST /api/admin/diagnostics/session` (see "Abuse and billing" below).
3. Runs `connectLucy`: token through `/api/fal/proxy`, SDP offer, answer, ICE. Every milestone is recorded with a
   timestamp, including the **type (or keys) of every message fal sends**, never their values. That list is the first
   real evidence of fal's message names: compare it with `Incoming` in `lib/fal/signaling.ts`.
4. Waits for the first frame on the output `<video>` (`requestVideoFrameCallback`), up to 55 s. The check cannot tell a
   transformed frame from any other frame, so look at the right-hand video yourself.
5. Samples `getStats()` every second for 10 s: decoded frames, resolution, round-trip time, jitter, packet loss. The
   connection must stay up the whole time: a peer that drops, or connectLucy reporting "Reconnecting…", fails the check at
   once (connectLucy itself would only give up 15 s later, after the window).
6. Closes everything (connection, camera tracks, remote tracks) and ends the diagnostics session, then shows the
   verdict, a table of numbers and steps, and **Copy as JSON**.

Each run holds a real fal connection for roughly 15 to 70 seconds, depending on how far it gets. fal's usage is billed to the
account behind `FAL_KEY` (how fal bills a failed or partial connection is unverified); no AltrCam credits are used.

## PASS criteria

Defined once in `lib/diagnostics/criteria.ts` (`PASS_CRITERIA`), applied by the page and again by the smoke script:

| Criterion | Rule |
|---|---|
| No failure or interruption | no failure code from the connection (token, socket, answer, ICE, model error) or the check itself, and no interruption during the sample window: no "Reconnecting…" from connectLucy and the peer `connected` at every sample (`connection_interrupted` otherwise) |
| Time to first frame (TTFF) | at most **15 s**, measured from the start of the connection (just before the token request) to the first frame presented in the output `<video>` |
| Frame rate | at least **10 fps**, the average decoded frame rate (`framesDecoded` from `getStats()`) over the sample window |
| No stall | at least **5 fps** in **every** interval between two consecutive samples (about 1 s each), including the last, so a freeze anywhere in the window fails even if the average is still above 10 |
| Sample window | **10 s** of sampling after the first frame, run to the end (within half a stats interval). A window cut short only happens with a failure or interruption, which already fails |

RTT, jitter, packet loss, resolution and the displayed frame rate are reported but are not part of PASS. A check that
passes says the connection works from that browser and network; it says nothing about restrictive networks (no TURN
server is used, see `README_LIMITATIONS.md`) or about output quality. Look at the video too.

## How to run it

### In the browser

1. Deploy to a preview with `FAL_KEY` set. Sign in with an account whose Clerk `publicMetadata.role` is `admin`.
2. Open `/admin/diagnostics` (or Admin → **Realtime diagnostics**). Optionally change the prompt.
3. Click **Run check**. Watch the left (sent) and right (received) panes. Leave the tab in front: background tabs throttle
   the synthetic camera's timer.
4. When it finishes, click **Copy as JSON** and keep the report. The page also lists recent checks (from the audit log).

### Headless, from a terminal

```bash
SMOKE_BASE_URL=https://<your-preview> SMOKE_ADMIN_EMAIL=<admin email> \
  npx tsx --env-file=.env.local scripts/smoke-realtime.ts > smoke.json; echo "exit $?"
```

It launches headless Chromium, signs in as the admin, opens `/admin/diagnostics`, clicks **Run check**, waits for the final
report, prints `{ smoke, report }` as JSON and exits **0 on PASS, 1 on anything else**. PASS is decided by the script itself
from the reported numbers, so a page that claims PASS with failing numbers is a FAIL.

Sign-in, the first one configured wins:

| Option | Variables | Notes |
|---|---|---|
| Clerk testing helpers (`@clerk/testing`) | `SMOKE_ADMIN_EMAIL`, plus `CLERK_SECRET_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` of the **target's** Clerk instance; optional `SMOKE_ADMIN_PASSWORD` | Signs in with a one-time sign-in token from Clerk's backend API (or the password). Testing tokens are meant for development instances; for production use one of the next two |
| Playwright storage state | `SMOKE_STORAGE_STATE=admin.json` | Make it once: `npx playwright codegen --save-storage=admin.json https://<target>/sign-in`, sign in, close the window. Keep the file private |
| Session cookie | `SMOKE_SESSION_COOKIE="__session=...; __client_uat=..."` | Clerk's `__session` lasts about a minute, so this only works if copied right before the run |

Also: `PW_CHROMIUM_PATH` (a Chromium binary when Playwright's bundled one is not installed), `SMOKE_TIMEOUT_MS` (default
120000). The script never prints the cookie, the storage state's values, `CLERK_SECRET_KEY`, the password or fal tokens; the
browser's own error messages, which can contain the fal token in the socket URL, are redacted.

## Recording a result

Add a row for every run against a real deployment, pass or fail. Paste the JSON somewhere durable (an issue, a gist) and link
it from the row. Leave the table empty until a real run has happened: do not record loopback or fixture runs here.

| Date (UTC) | Endpoint | TTFF | FPS | RTT | Pass/fail |
|---|---|---|---|---|---|

_Not yet run against production._

**The "Live video isn't confirmed yet" notices stay up until a passing run is recorded in this table.** That is the public
notice (`lib/availability.ts`, shown on the landing page, `/how-it-works`, `/pricing`, the FAQ and `/billing`), the Studio's own
notice, and the hedged wording in `app/layout.tsx`. After a passing run, follow `GO_LIVE.md` section 7 ("When a real session
has worked") to change them, together with the tests that pin them. A failing run changes nothing except this table.

## When it fails

The report's `failure.code` is the connection's own (`lib/fal/signaling.ts` `FailureCode`) or one of the check's:

| Code | Meaning |
|---|---|
| `not_configured` | the server has no `FAL_KEY` (503 from the diagnostics session route) |
| `session_refused`, `session_unreachable` | the diagnostics session was refused (not an admin: 403; signed out: 401) or the server could not be reached |
| `token_refused`, `token_unreachable` | `/api/fal/proxy` refused the token request (status in the report) or fal's token endpoint could not be reached |
| `socket_error`, `model_error`, `bad_answer`, `answer_timeout`, `ice_failed`, `connection_lost` | see the symptom table in `GO_LIVE.md` section 7 |
| `connection_interrupted` | the peer left `connected`, or connectLucy reported "Reconnecting…", during the sample window |
| `no_first_frame` | no video frame within 55 s; the message says whether the WebRTC connection itself was established |
| `aborted`, `camera_error`, `diagnostics_error` | the check was stopped, the browser could not draw/capture the canvas, or the check itself failed |

For an `answer_timeout`, read `serverMessages` and `steps` in the JSON first: they show whether fal sent anything at all and
under what message types, which is what decides whether the names or the sequence in `signaling.ts` must change.

## Abuse and billing

The token proxy only mints a fal token for an open studio session of the signed-in user, so the check needs one. The
diagnostics session route (`lib/admin-diagnostics.ts`) is admin-only on every call (401 signed out, 403 for non-admins, who
get no row and so no token); the proxy checks the session's owner, so no one else can use an admin's session id. The row has
`max_seconds = 0`, so whatever meters it (an end, a heartbeat, the stale sweep, the admin's next Studio start) debits
nothing; it is labelled (`settings.diagnostics`, end reason `diagnostics`), rate-limited, at most one is open per admin,
the admin's own Studio session is left alone, and every start and result is written to the audit log. Its end route only
closes the caller's own diagnostics rows, so it cannot close a normal Studio session unbilled. A diagnostics row is
identified by `max_seconds = 0` **and** the settings flag, not the flag alone (the Studio's start route stores the caller's
settings as sent, and plan session limits are at least 10 s, so no Studio row has `max_seconds = 0`). A result is recorded
only by the request that closes the row: a later end with a result gets 409, so there is one audit record per check.

Known edges: a diagnostics row never heartbeats, so the stale sweep may close it (as `stale`, still unbilled) while a long
check is running. That does not stop the connection, whose token is already minted, but a token request made after that
(the fal client opening a second socket) would be refused. The same applies if the proxy later refuses sessions that were
never marked live after 30 s. If the sweep closed the row first, the page's own end gets 409 and the result is not in the
audit log (it is still in the page's JSON). The Studio's start route still accepts a `diagnostics` key in its settings;
stripping it there belongs to the stream that owns that route (this one was asked not to change it), and is harmless now
that the flag alone no longer identifies a diagnostics row.

## What is tested without fal

None of this replaces a real run; it shows the tool itself measures and cleans up correctly.

- `tests/unit/diagnostics-run.test.ts`: the check's flow, numbers, PASS rule and cleanup on every exit path, with fakes.
- `tests/public/diagnostics.spec.ts`: the real check and synthetic camera in real Chromium against a **local WebRTC
  loopback** instead of fal (it passes there at about 29 fps, 640x360; that proves the measuring, not Lucy).
- `tests/unit/diagnostics-gate.test.ts`: admin gating, the abuse cases and zero billing, with a real Postgres engine.
- `tests/unit/smoke-script.test.ts`: the smoke script end to end against a local fixture of the page.
- `tests/unit/fal-proxy.test.ts`, `tests/unit/client-secrets.test.ts`: the token proxy audit and that `FAL_KEY` never
  reaches browser code. After a build, `scripts/check-client-bundle.ts` checks the output itself:
  `FAL_KEY=<distinctive fake> npm run build && FAL_KEY=<same fake> npx tsx scripts/check-client-bundle.ts`.
