#!/usr/bin/env bash
# Runs the PostgreSQL adapter integration tests against a throwaway local Docker container
# (ADR-046 / D21; no testcontainers). Usage, from packages/server:
#   bash scripts/test-postgres.sh [extra vitest args]
# What it does: starts postgres:16-alpine on a free 127.0.0.1 port with random throwaway
# credentials, seeds scripts/postgres-seed.sql (sample schema + a SELECT-only role), exports
# DEVWS_TEST_PG_URL / DEVWS_TEST_PG_RO_URL for the test process only, runs the Docker test file,
# and ALWAYS removes the container on exit. Without Docker it prints a clear SKIPPED message and
# exits 0 (the default `pnpm test` skips these tests the same way when the variables are unset).
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pkg="$(dirname "$here")"
image="${DEVWS_TEST_PG_IMAGE:-postgres:16-alpine}"
name="devws-pg-test-$$"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIPPED: Docker is not available; PostgreSQL integration tests were not run." >&2
  exit 0
fi

rand() { head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
admin_pw="$(rand)"
ro_pw="$(rand)"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

# Port 0 on the host side: Docker picks a free port, bound to loopback only.
if ! docker run -d --rm --name "$name" \
  -e POSTGRES_PASSWORD="$admin_pw" -e POSTGRES_DB=devws_test \
  -p 127.0.0.1::5432 "$image" >/dev/null; then
  echo "SKIPPED: could not start the $image container (is the image available offline?)." >&2
  exit 0
fi

ready=0
for _ in $(seq 1 60); do
  if docker exec "$name" pg_isready -h 127.0.0.1 -U postgres -d devws_test >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != 1 ]; then echo "ERROR: postgres container did not become ready in 60s." >&2; exit 1; fi

port="$(docker port "$name" 5432/tcp | head -n1 | sed 's/.*://')"
docker exec -i "$name" psql -v ON_ERROR_STOP=1 -q -U postgres -d devws_test -v ro_password="$ro_pw" \
  <"$here/postgres-seed.sql" >/dev/null || { echo "ERROR: seeding failed." >&2; exit 1; }

export DEVWS_TEST_PG_URL="postgres://postgres:${admin_pw}@127.0.0.1:${port}/devws_test"
export DEVWS_TEST_PG_RO_URL="postgres://dw_ro:${ro_pw}@127.0.0.1:${port}/devws_test"
export DEVWS_TEST_PG_HOST_PORT="127.0.0.1:${port}"

cd "$pkg" && pnpm exec vitest run test/integration/postgres.adapter.docker.test.ts "$@"
