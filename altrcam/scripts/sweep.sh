#!/usr/bin/env bash
# Calls one of AltrCam's cron endpoints with the shared secret. Used by .github/workflows/altrcam-sweep.yml so the
# 5-minute stale-session sweep works on Vercel's Hobby plan (which only allows daily crons).
#
#   ALTRCAM_URL=https://altrcam.com CRON_SECRET=... bash altrcam/scripts/sweep.sh [stale-sessions|refill|retention]
#
# Exit codes: 0 ok · 1 request failed (after retries) or rejected · 2 bad configuration.
# The secret is only ever sent in a header; this script never prints it and never enables shell tracing.
set -euo pipefail

: "${ALTRCAM_URL:?ALTRCAM_URL is not set}"
: "${CRON_SECRET:?CRON_SECRET is not set}"

endpoint="${1:-stale-sessions}"
case "$endpoint" in
  stale-sessions | refill | retention) ;;
  *) echo "unknown endpoint '$endpoint' (expected stale-sessions, refill or retention)" >&2; exit 2 ;;
esac

base="${ALTRCAM_URL%/}"
case "$base" in
  https://?*) ;;
  http://localhost* | http://127.0.0.1*) ;; # local testing only
  *) echo "ALTRCAM_URL must be an https:// URL (got '$base')" >&2; exit 2 ;;
esac

attempts="${SWEEP_ATTEMPTS:-3}"
delay="${SWEEP_RETRY_DELAY:-5}"
timeout="${SWEEP_TIMEOUT:-30}"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

for ((i = 1; i <= attempts; i++)); do
  status="$(curl --silent --show-error --output "$body" --write-out '%{http_code}' --max-time "$timeout" \
    --header "Authorization: Bearer ${CRON_SECRET}" "${base}/api/cron/${endpoint}" 2>/dev/null)" || status="000"

  case "$status" in
    2??)
      echo "ok (HTTP $status): $(head -c 300 "$body")"
      exit 0
      ;;
    401 | 403)
      # Retrying can't fix a wrong secret, and hammering the endpoint with it would only add noise.
      echo "rejected (HTTP $status): CRON_SECRET here doesn't match the one configured on the deployment" >&2
      exit 1
      ;;
  esac

  echo "attempt $i/$attempts failed (HTTP $status)" >&2
  if ((i < attempts)); then sleep "$delay"; fi
done

echo "giving up on $endpoint after $attempts attempts" >&2
exit 1
