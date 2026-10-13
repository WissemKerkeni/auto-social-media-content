#!/bin/sh
# Creates/updates separate roles + databases for n8n, the application and (optionally) Langfuse.
#
# Runs automatically on the first start of an EMPTY postgres_data volume, and is
# idempotent so `npm run dev:up` re-runs it on existing volumes:
#   docker compose exec -T postgres sh /docker-entrypoint-initdb.d/10-create-databases.sh
#
# - Values are passed as psql variables and quoted with format(%I/%L), so names and
#   passwords are never spliced into SQL text by the shell.
# - Role passwords are re-applied on every run: .env is the source of truth.
# - Every database defaults to UTC. Langfuse requires it, and it keeps timestamps
#   unambiguous; Africa/Tunis conversion happens explicitly in application code.
set -eu

: "${N8N_DB_NAME:?}" "${N8N_DB_USER:?}" "${N8N_DB_PASSWORD:?}"
: "${APP_DB_NAME:?}" "${APP_DB_USER:?}" "${APP_DB_PASSWORD:?}"

# ensure_db <db> <user> <password> <extra role options>
ensure_db() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
    -v db="$1" -v usr="$2" -v pw="$3" -v opts="$4" <<'EOSQL'
SELECT format('CREATE ROLE %I LOGIN', :'usr')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'usr') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN %s PASSWORD %L', :'usr', :'opts', :'pw') \gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'usr')
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \gexec
SELECT format('ALTER DATABASE %I SET timezone TO %L', :'db', 'UTC') \gexec
EOSQL
  echo "init: ensured database '$1' (owner '$2', timezone UTC)"
}

ensure_db "$N8N_DB_NAME" "$N8N_DB_USER" "$N8N_DB_PASSWORD" "NOCREATEDB"
# CREATEDB lets `prisma migrate dev` create its shadow database (local dev only).
ensure_db "$APP_DB_NAME" "$APP_DB_USER" "$APP_DB_PASSWORD" "CREATEDB"

if [ -n "${LANGFUSE_DB_PASSWORD:-}" ]; then
  ensure_db "${LANGFUSE_DB_NAME:-langfuse}" "${LANGFUSE_DB_USER:-langfuse}" "$LANGFUSE_DB_PASSWORD" "NOCREATEDB"
fi
