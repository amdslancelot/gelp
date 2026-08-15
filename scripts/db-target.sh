#!/usr/bin/env bash
#
# Run a command against a chosen database — staging or production — without
# either one ever being the default.
#
#   scripts/db-target.sh staging npx tsx scripts/backfill-categories.ts
#   scripts/db-target.sh prod    npx tsx scripts/load-resolved.ts data/x.jsonl
#
# Why this exists
# ---------------
# The backfill is a three-step pipeline (dump the work list, scrape it on this
# laptop, write the answers back) and every step needs a DATABASE_URL. Setting
# that by hand once per step is how the dump comes from staging and the write
# lands in prod. So the target is named once, at the front of the command, and
# this script is the only thing that turns a name into a connection.
#
# Neither target is reachable directly:
#
#   staging  minikube's Postgres, via the port-forward scripts/db-forward.sh
#            already manages on localhost:5432. Credentials come from .env.
#
#   prod     the k3s cluster's Postgres is a ClusterIP Service with no external
#            address, by design. Reached through a two-hop tunnel: kubectl
#            port-forward on the server, wrapped in an ssh -L to here.
#
# The production password
# -----------------------
# Read at run time out of the `gelp-env` Kubernetes Secret and held in this
# process's environment for the length of the command. It is never written to
# disk, never echoed, and never passed as an argv (which `ps` would show) — the
# child gets it through the environment. There is deliberately no local copy of
# the prod password to go stale, leak, or be committed.
#
# Every prod run prints what it is about to touch and, when the command can
# write, asks. A dump is a read and goes ahead; anything else stops for a y/N.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The production node. An IP rather than a name because there is no DNS record
# for the node itself — gelp.lans-h.cc points at Traefik, not at sshd.
PROD_SSH="${GELP_PROD_SSH:-opc@92.5.135.46}"
PROD_SSH_KEY="${GELP_PROD_SSH_KEY:-${HOME}/.ssh/oci_deploy_key}"
# Not 5432: the staging forward may well be up on that port at the same time,
# and a backfill that dumps from one database and writes to the other is the
# exact accident this whole script exists to prevent.
PROD_LOCAL_PORT="${GELP_PROD_LOCAL_PORT:-15432}"
KUBECTL="sudo /usr/local/bin/kubectl"

die() { echo "db-target: $*" >&2; exit 1; }

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3>&- && return 0
  return 1
}

# ---------------------------------------------------------------------------
# staging — reuse the existing forward and .env, so dev and this agree.
# ---------------------------------------------------------------------------
setup_staging() {
  bash "${REPO_ROOT}/scripts/db-forward.sh" start >&2

  [ -f "${REPO_ROOT}/.env" ] || die "no .env — copy .env.example and fill it in"
  # Sourced in a subshell-free way but only for this variable: .env is a
  # KEY=value file, not a script, and running the whole of it would be a
  # surprise waiting to happen.
  local url
  url="$(grep -E '^DATABASE_URL=' "${REPO_ROOT}/.env" | head -1 | cut -d= -f2-)"
  [ -n "${url}" ] || die "DATABASE_URL not set in .env"
  export DATABASE_URL="${url}"
  echo "db-target: staging — minikube Postgres via localhost:5432" >&2
}

# ---------------------------------------------------------------------------
# prod — tunnel, then the real credentials out of the cluster Secret.
# ---------------------------------------------------------------------------
TUNNEL_PID=""
cleanup_tunnel() {
  if [ -n "${TUNNEL_PID}" ]; then
    kill "${TUNNEL_PID}" 2>/dev/null || true
    wait "${TUNNEL_PID}" 2>/dev/null || true
    echo "db-target: prod tunnel closed" >&2
  fi
}

setup_prod() {
  [ -f "${PROD_SSH_KEY}" ] || die "no ssh key at ${PROD_SSH_KEY}"
  port_open "${PROD_LOCAL_PORT}" &&
    die "something already answers on localhost:${PROD_LOCAL_PORT} — refusing to
guess whether it is a stale tunnel or another database. Close it first."

  # One ssh doing both hops: -L brings the port here, and the remote command is
  # the kubectl forward it lands on. The Service name is used rather than the
  # ClusterIP so this keeps working when Postgres is redeployed and the IP
  # changes.
  ssh -i "${PROD_SSH_KEY}" \
      -L "${PROD_LOCAL_PORT}:127.0.0.1:${PROD_LOCAL_PORT}" \
      -o ExitOnForwardFailure=yes \
      "${PROD_SSH}" \
      "${KUBECTL} -n data port-forward --address 127.0.0.1 svc/postgres ${PROD_LOCAL_PORT}:5432" \
      >/dev/null 2>&1 &
  TUNNEL_PID=$!
  trap cleanup_tunnel EXIT

  for _ in $(seq 1 40); do
    port_open "${PROD_LOCAL_PORT}" && break
    # The forward dying is the common failure (no sudo, kubectl missing, the
    # cluster down), and without this the loop just waits out its full timeout
    # before reporting a tunnel that was never going to open.
    kill -0 "${TUNNEL_PID}" 2>/dev/null || die "tunnel died — try the ssh by hand"
    sleep 0.5
  done
  port_open "${PROD_LOCAL_PORT}" || die "tunnel never came up"

  # The whole URL, not just the password: it carries the role and database name
  # too, and reconstructing those here would be a second place to keep right.
  local remote_url
  remote_url="$(ssh -i "${PROD_SSH_KEY}" "${PROD_SSH}" \
    "${KUBECTL} -n gelp get secret gelp-env -o jsonpath='{.data.DATABASE_URL}' | base64 -d")"
  [ -n "${remote_url}" ] || die "could not read DATABASE_URL from the gelp-env Secret"

  # In-cluster the host is postgres.data.svc; from here it is the tunnel.
  export DATABASE_URL="${remote_url/@postgres.data.svc:5432/@127.0.0.1:${PROD_LOCAL_PORT}}"
  [ "${DATABASE_URL}" != "${remote_url}" ] ||
    die "the Secret's DATABASE_URL does not point at postgres.data.svc:5432 — it
reads '${remote_url//:*@/:***@}'. Rewriting it blind would connect the command
to whatever that host is, so this stops instead."

  echo "db-target: PRODUCTION — gelp.lans-h.cc, via localhost:${PROD_LOCAL_PORT}" >&2
}

# ---------------------------------------------------------------------------
main() {
  local target="${1:-}"
  shift || true
  [ $# -gt 0 ] || {
    echo "usage: $0 {staging|prod} <command> [args...]" >&2
    exit 1
  }

  case "${target}" in
    staging) setup_staging ;;
    prod)
      setup_prod
      # A command with no --apply cannot write, and stopping a read-only dump
      # for a prompt just trains the answer out of meaning anything. Everything
      # else asks, because on this target there is no undo.
      if printf '%s\n' "$@" | grep -qx -- '--apply'; then
        echo "" >&2
        echo "This will WRITE to production: $*" >&2
        read -r -p "Type 'yes' to continue: " reply </dev/tty
        [ "${reply}" = "yes" ] || die "aborted"
      fi
      ;;
    *) die "unknown target '${target}' — use 'staging' or 'prod'" ;;
  esac

  echo "db-target: running: $*" >&2
  echo "" >&2
  "$@"
}

main "$@"
