#!/usr/bin/env bash
# Fresh local stack for browser tests: built assets + wrangler dev + seeded throwaway D1.
set -euo pipefail
PORT="${E2E_PORT:-8788}"
STATE=.wrangler/e2e
rm -rf "$STATE"
[ -d dist/client ] || npx vite build
npx wrangler d1 migrations apply DB --local --persist-to "$STATE" >/dev/null
node scripts/seed-dev.mjs >/dev/null
npx wrangler d1 execute DB --local --persist-to "$STATE" --file=.wrangler/seed-dev.sql >/dev/null
exec npx wrangler dev --port "$PORT" --local --local-upstream "localhost:$PORT" --persist-to "$STATE" --env-file /dev/null \
  --var ENVIRONMENT:development --var DEV_USER_EMAIL:owner@example.com --var OWNER_EMAIL:owner@example.com \
  --var APP_SECRET:dev-only-insecure-secret-change-me-0123456789 --var TURNSTILE_SITE_KEY:
