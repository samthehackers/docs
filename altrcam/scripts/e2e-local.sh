#!/usr/bin/env bash
# End-to-end tests against a LOCAL Supabase stack (Docker). Never touches a hosted project.
#
#   npm run test:e2e:local            # from altrcam/
#   E2E_PORT=3206 PW_CHROMIUM_PATH=/path/to/chrome npm run test:e2e:local
#
# 1. starts Supabase from supabase/config.toml (Auth with email confirmations ON, Postgres, Mailpit) with the services
#    the app doesn't use left out;
# 2. applies db/migrations through scripts/migrate.ts using POSTGRES_URL_NON_POOLING;
# 3. builds and starts the app with the env names the Vercel Supabase integration sets in production, including a
#    POSTGRES_URL that carries the integration's extra query parameters (supa=…), so that path is exercised;
# 4. runs tests/e2e (Playwright).
#
# Set SUPABASE_INTERNAL_IMAGE_REGISTRY=docker.io if the default registry (public.ecr.aws) is blocked where you are.
# Leaves the stack running; stop it with `npx supabase stop`.
set -euo pipefail
cd "$(dirname "$0")/.."

SUPABASE="npx --yes supabase@2"
$SUPABASE start -x studio,realtime,storage-api,imgproxy,edge-runtime,logflare,vector,postgres-meta,supavisor >/dev/null
eval "$($SUPABASE status -o env | grep -E '^(API_URL|DB_URL|PUBLISHABLE_KEY|SECRET_KEY|ANON_KEY|MAILPIT_URL)=')"

case "$API_URL" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "refusing: $API_URL is not local" >&2; exit 2 ;; esac

POSTGRES_URL_NON_POOLING="$DB_URL?sslmode=disable" npx tsx scripts/migrate.ts

export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY="$PUBLISHABLE_KEY"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export SUPABASE_URL="$API_URL"
export SUPABASE_SECRET_KEY="$SECRET_KEY"
export POSTGRES_URL="$DB_URL?sslmode=disable&supa=base-pooler.x"
export POSTGRES_PRISMA_URL="$DB_URL?sslmode=disable&supa=base-pooler.x&pgbouncer=true&connect_timeout=15"
export POSTGRES_URL_NON_POOLING="$DB_URL?sslmode=disable"
export MAILPIT_URL
unset DATABASE_URL FAL_KEY PAYSTACK_SECRET_KEY NOWPAYMENTS_API_KEY NOWPAYMENTS_IPN_SECRET RESEND_API_KEY UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN CRON_SECRET

npx playwright test -c "${PW_CONFIG:-playwright.config.ts}" "$@"
