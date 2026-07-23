#!/usr/bin/env bash
#
# One-time provisioning of gelp's database + role on the shared Postgres in the
# `data` namespace, per snoopy_home/docs/PLAN-postgres-role-isolation.md:
#
#   - role  gelp_rw  (LOGIN only — no superuser/CREATEDB/CREATEROLE)
#   - database gelp, owned by gelp_rw
#   - REVOKE CONNECT ... FROM PUBLIC  → no other app's role can reach it
#   - public schema owned by gelp_rw, revoked from PUBLIC
#
# Run once per cluster (staging minikube, prod k3s) against the current kubectl
# context. The gelp_rw password is read from GELP_DB_PASSWORD, or extracted from
# .env's DATABASE_URL when unset (the dev setup keeps them identical for the
# staging cluster). It is never echoed.
#
#   scripts/provision-db.sh              # uses .env / GELP_DB_PASSWORD
#   GELP_DB_PASSWORD=... scripts/provision-db.sh
#
# The script is idempotent: an existing role gets its password reset; an
# existing database is left in place (grants are re-applied).
set -euo pipefail

NAMESPACE=data
WORKLOAD="${POSTGRES_WORKLOAD:-deploy/postgres}"

PW="${GELP_DB_PASSWORD:-}"
if [ -z "$PW" ] && [ -f .env ]; then
  PW=$(sed -n 's|^DATABASE_URL=postgres://gelp_rw:\([^@]*\)@.*|\1|p' .env)
fi
if [ -z "$PW" ]; then
  echo "ERROR: set GELP_DB_PASSWORD or put the gelp_rw password in .env's DATABASE_URL." >&2
  exit 1
fi
# The password goes into a DATABASE_URL and into an inline SQL literal, and is
# extracted from .env with an @-delimited regex — so keep it URL-safe. Reject
# anything that could break those assumptions rather than fail obscurely later.
if ! printf '%s' "$PW" | grep -qE '^[A-Za-z0-9]+$'; then
  echo "ERROR: the gelp_rw password must be letters/digits only (URL-safe)." >&2
  echo "Regenerate with: openssl rand -hex 24" >&2
  exit 1
fi

echo "==> Provisioning gelp on ${WORKLOAD} in namespace ${NAMESPACE} (context: $(kubectl config current-context))"

kubectl -n "$NAMESPACE" exec -i "$WORKLOAD" -- psql -U postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'gelp_rw') THEN
    ALTER ROLE gelp_rw WITH LOGIN PASSWORD '$PW';
  ELSE
    CREATE ROLE gelp_rw LOGIN PASSWORD '$PW';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE gelp OWNER gelp_rw'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'gelp') \gexec
REVOKE CONNECT ON DATABASE gelp FROM PUBLIC;
GRANT CONNECT ON DATABASE gelp TO gelp_rw;
SQL

kubectl -n "$NAMESPACE" exec -i "$WORKLOAD" -- psql -U postgres -d gelp -v ON_ERROR_STOP=1 <<'SQL'
ALTER SCHEMA public OWNER TO gelp_rw;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
SQL

echo "==> Verifying isolation (per the canonical plan)"
echo "--- gelp_rw -> gelp (must succeed):"
kubectl -n "$NAMESPACE" exec "$WORKLOAD" -- env PGPASSWORD="$PW" \
  psql -h 127.0.0.1 -U gelp_rw -d gelp -tAc 'select 1'
# Prove gelp_rw is refused on another app's database — but only if such a
# database actually exists here, otherwise a "does not exist" error would be
# mistaken for a permission refusal and the check would pass without testing
# anything.
PEER=snoopy_home
echo "--- gelp_rw -> ${PEER} (must be refused):"
peer_exists=$(kubectl -n "$NAMESPACE" exec "$WORKLOAD" -- \
  psql -U postgres -tAc "select 1 from pg_database where datname='${PEER}'")
if [ "$peer_exists" != "1" ]; then
  echo "skipped — '${PEER}' is not present on this server, so there is no peer DB to test isolation against"
elif kubectl -n "$NAMESPACE" exec "$WORKLOAD" -- env PGPASSWORD="$PW" \
  psql -h 127.0.0.1 -U gelp_rw -d "${PEER}" -c '\q' 2>/dev/null; then
  echo "ERROR: isolation broken — gelp_rw connected to ${PEER}" >&2
  exit 1
else
  echo "refused, as required"
fi
echo "--- app-role attributes (all must be f/f/f):"
kubectl -n "$NAMESPACE" exec "$WORKLOAD" -- psql -U postgres -tAc \
  "select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname like '%\_rw'"

echo "==> Done"
