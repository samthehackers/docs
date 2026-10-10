#!/usr/bin/env bash
# A real Supabase Auth server (GoTrue) on this machine, for the auth integration and browser tests. Nothing here talks to the
# hosted project. Needs: a GoTrue binary (GOTRUE_BIN; build it with `go build` from github.com/supabase/auth, or copy /usr/local/bin/auth
# out of the supabase/gotrue Docker image), a PostgreSQL superuser URL (LOCAL_AUTH_PG), Node 22.
#
#   GOTRUE_BIN=/path/to/gotrue LOCAL_AUTH_PG=postgres://postgres@127.0.0.1:5432/postgres scripts/local-auth.sh
#
# It creates (once) a database for GoTrue and the app (LOCAL_AUTH_DB, default altrcam_auth_test) with the supabase_auth_admin role,
# starts tests/support/local-auth-stack.mjs (API gateway under /auth/v1, email templates, SMTP sink), then runs GoTrue in the
# foreground. It prints the env the app and tests need. "Confirm email" is ON, as it must be in production.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${GOTRUE_BIN:?set GOTRUE_BIN to a GoTrue binary}"
: "${LOCAL_AUTH_PG:?set LOCAL_AUTH_PG to a PostgreSQL superuser URL}"
DB="${LOCAL_AUTH_DB:-altrcam_auth_test}"
STACK_PORT="${AUTH_STACK_PORT:-54390}"
GOTRUE_PORT="${GOTRUE_PORT:-54391}"
SMTP_PORT="${AUTH_SMTP_PORT:-54392}"
SITE="${LOCAL_AUTH_SITE_URL:-http://localhost:3205}"
JWT_SECRET="${LOCAL_AUTH_JWT_SECRET:-local-test-jwt-secret-not-for-production-0123456789}"

psql "$LOCAL_AUTH_PG" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    CREATE ROLE supabase_auth_admin NOINHERIT CREATEROLE LOGIN NOREPLICATION PASSWORD 'root';
  END IF;
END \$\$;
SQL
if [ "$(psql "$LOCAL_AUTH_PG" -tAc "select 1 from pg_database where datname = '$DB'")" != "1" ]; then
  psql "$LOCAL_AUTH_PG" -q -c "create database $DB"
fi
DB_URL="${LOCAL_AUTH_PG%/*}/$DB"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q <<SQL
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
GRANT CREATE ON DATABASE $DB TO supabase_auth_admin;
ALTER ROLE supabase_auth_admin SET search_path = 'auth';
SQL

# Keys, the way a hosted project's legacy anon / service_role keys are made: HS256 JWTs signed with the project's JWT secret.
key() { node -e '
  const c = require("node:crypto"), b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = b({ alg: "HS256", typ: "JWT" }) + "." + b({ iss: "supabase-local", role: process.argv[1], iat: 1700000000, exp: 4100000000 });
  process.stdout.write(body + "." + c.createHmac("sha256", process.argv[2]).update(body).digest("base64url"));' "$1" "$JWT_SECRET"; }
ANON="$(key anon)"; SERVICE="$(key service_role)"
HOST_PG="${DB_URL#*://}"; HOST_PG="${HOST_PG#*@}"
cat <<ENV
# --- local auth stack env ---
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:$STACK_PORT
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$ANON
SUPABASE_URL=http://127.0.0.1:$STACK_PORT
SUPABASE_SERVICE_ROLE_KEY=$SERVICE
LOCAL_AUTH_MAIL_URL=http://127.0.0.1:$STACK_PORT/__mail
DATABASE_URL=$DB_URL
# ----------------------------
ENV

AUTH_STACK_PORT="$STACK_PORT" AUTH_SMTP_PORT="$SMTP_PORT" GOTRUE_INTERNAL_URL="http://127.0.0.1:$GOTRUE_PORT" node tests/support/local-auth-stack.mjs &
STACK_PID=$!
trap 'kill $STACK_PID 2>/dev/null || true' EXIT

T="http://127.0.0.1:$STACK_PORT/__templates"
export GOTRUE_DB_DRIVER=postgres DB_NAMESPACE=auth GOTRUE_DB_AUTOMIGRATE=true
export DATABASE_URL="postgres://supabase_auth_admin:root@$HOST_PG?sslmode=disable"
export GOTRUE_API_HOST=127.0.0.1 PORT="$GOTRUE_PORT" API_EXTERNAL_URL="http://127.0.0.1:$STACK_PORT/auth/v1"
export GOTRUE_JWT_SECRET="$JWT_SECRET" GOTRUE_JWT_EXP=3600 GOTRUE_JWT_AUD=authenticated GOTRUE_JWT_DEFAULT_GROUP_NAME=authenticated
export GOTRUE_JWT_ADMIN_ROLES=service_role,supabase_admin
export GOTRUE_SITE_URL="$SITE" GOTRUE_URI_ALLOW_LIST="$SITE/**"
export GOTRUE_DISABLE_SIGNUP=false GOTRUE_EXTERNAL_EMAIL_ENABLED=true GOTRUE_MAILER_AUTOCONFIRM=false GOTRUE_PASSWORD_MIN_LENGTH=8
export GOTRUE_SMTP_HOST=127.0.0.1 GOTRUE_SMTP_PORT="$SMTP_PORT" GOTRUE_SMTP_ADMIN_EMAIL=noreply@altrcam.test GOTRUE_SMTP_SENDER_NAME=AltrCam
export GOTRUE_SMTP_MAX_FREQUENCY=1s GOTRUE_RATE_LIMIT_EMAIL_SENT=10000 GOTRUE_RATE_LIMIT_VERIFY=10000 GOTRUE_RATE_LIMIT_TOKEN_REFRESH=10000
export GOTRUE_RATE_LIMIT_SSO=10000 GOTRUE_RATE_LIMIT_OTP=10000
export GOTRUE_MAILER_TEMPLATES_CONFIRMATION="$T/confirmation.html" GOTRUE_MAILER_TEMPLATES_RECOVERY="$T/recovery.html"
export GOTRUE_MAILER_TEMPLATES_EMAIL_CHANGE="$T/email_change.html" GOTRUE_MAILER_TEMPLATES_MAGIC_LINK="$T/magic_link.html"
export GOTRUE_MAILER_SUBJECTS_CONFIRMATION="Confirm your AltrCam email" GOTRUE_MAILER_SUBJECTS_RECOVERY="Reset your AltrCam password"
export GOTRUE_MAILER_SUBJECTS_EMAIL_CHANGE="Confirm your new AltrCam email"
# Google, with a fake client: enough to test the redirect, the PKCE state and the cancel/deny path. Never reaches Google.
export GOTRUE_EXTERNAL_GOOGLE_ENABLED=true GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID=local-test-client GOTRUE_EXTERNAL_GOOGLE_SECRET=local-test-secret
export GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI="http://127.0.0.1:$STACK_PORT/auth/v1/callback"
export GOTRUE_LOG_LEVEL="${GOTRUE_LOG_LEVEL:-warn}"
"$GOTRUE_BIN"
