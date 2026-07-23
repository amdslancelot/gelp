#!/usr/bin/env bash
#
# Manage the background port-forward that gives local dev its database. Dev has
# no Postgres of its own: `npm run dev` talks to the shared staging Postgres
# inside minikube (namespace `data`, Service `postgres` — deployed and owned by
# the snoopy_home repo, see its docs/PLAN-postgres-role-isolation.md), reached
# on localhost:5432 through this tunnel.
#
#   scripts/db-forward.sh start   # npm run db:up
#   scripts/db-forward.sh stop    # npm run db:down
#
# `start` is idempotent: if something already answers on localhost:5432 it does
# nothing (whether that's an earlier forward or anything else claiming the port).

set -euo pipefail

NAMESPACE=data
SERVICE=postgres
PORT=5432
PID_FILE="${TMPDIR:-/tmp}/gelp-db-forward.pid"
LOG_FILE="${TMPDIR:-/tmp}/gelp-db-forward.log"

port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null && exec 3>&- && return 0
  return 1
}

start() {
  if port_open; then
    echo "db-forward: localhost:${PORT} already answering — nothing to do"
    return 0
  fi

  if ! kubectl get svc "${SERVICE}" -n "${NAMESPACE}" >/dev/null 2>&1; then
    echo "db-forward: Service '${SERVICE}' not found in namespace '${NAMESPACE}'." >&2
    echo "Is minikube running with the shared Postgres applied? It is provisioned by" >&2
    echo "the snoopy_home repo: snoopy_home/deploy/setup-minikube.sh" >&2
    exit 1
  fi

  echo "db-forward: starting kubectl port-forward svc/${SERVICE} -n ${NAMESPACE} ${PORT}:${PORT}"
  nohup kubectl -n "${NAMESPACE}" port-forward "svc/${SERVICE}" "${PORT}:${PORT}" \
    >"${LOG_FILE}" 2>&1 &
  echo $! >"${PID_FILE}"

  # Wait for the tunnel to accept connections before declaring success.
  for _ in $(seq 1 30); do
    if port_open; then
      echo "db-forward: ready on localhost:${PORT} (pid $(cat "${PID_FILE}"))"
      return 0
    fi
    sleep 0.5
  done

  # Tear down the orphaned forward rather than leaving it running behind a
  # port that never came up.
  echo "db-forward: tunnel did not become ready; see ${LOG_FILE}" >&2
  kill "$(cat "${PID_FILE}")" 2>/dev/null || true
  rm -f "${PID_FILE}"
  exit 1
}

stop() {
  if [ -f "${PID_FILE}" ]; then
    pid="$(cat "${PID_FILE}")"
    if kill "${pid}" 2>/dev/null; then
      echo "db-forward: stopped (pid ${pid})"
    else
      echo "db-forward: no running forward for pid ${pid} (already stopped?)"
    fi
    rm -f "${PID_FILE}"
  else
    echo "db-forward: no PID file at ${PID_FILE} — nothing to stop"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *)
    echo "Usage: $0 {start|stop}" >&2
    exit 1
    ;;
esac
