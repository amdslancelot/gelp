#!/usr/bin/env bash
#
# One command from Google Maps to production Gelp:
#
#   npm run sync:maps
#
#   1. scripts/takeout-export.py   request a Saved-only Takeout export, wait for
#                                  it, download the zip to data/takeout/
#   2. scripts/import-zip.ts       import it into prod as the owner below
#   3. queue:resolve               read exact coordinates for the places the
#                                  import queued, and load them
#
# Steps 2 and 3 run inside one scripts/db-target.sh prod call, so there is one
# tunnel and one "Type 'yes'" — that prompt is db-target's guard on every prod
# write and is deliberately not bypassed here.
#
# The owner is the first address in ALLOWED_EMAILS in .env, or GELP_EMAIL.
# The Takeout page check runs through the Claude Code CLI (`claude -p`).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

die() { echo "sync-maps: $*" >&2; exit 1; }

# Read one KEY=value out of .env without running the file (same as db-target).
env_value() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | head -1 | cut -d= -f2-
}

# --- inside the prod tunnel: DATABASE_URL is set by db-target --------------
if [ "${1:-}" = "--inner" ]; then
  zip="$2"; email="$3"
  npx tsx scripts/import-zip.ts "${zip}" --email="${email}" --apply
  # Coordinates already read on an earlier run — against this database or the
  # other one; the file is keyed by place, not by database — go in first, so
  # the queue dumped next holds only what nobody has resolved yet.
  if [ -f data/place-coords.jsonl ]; then
    npx tsx scripts/load-resolved.ts data/place-coords.jsonl --apply
  fi
  npx tsx scripts/dump-queue.ts
  python3 scripts/resolve-cids.py --input data/queue.jsonl
  npx tsx scripts/load-resolved.ts data/place-coords.jsonl --apply
  exit 0
fi

# --- outside: fetch the export, then hand off to the tunnel ----------------
email="${GELP_EMAIL:-$(env_value ALLOWED_EMAILS | cut -d, -f1 | tr -d ' ')}"
[ -n "${email}" ] || die "no owner email — set GELP_EMAIL or ALLOWED_EMAILS in .env"

echo "sync-maps: exporting Saved from Google Takeout" >&2
zip="$(python3 scripts/takeout-export.py "$@" | tail -1)"
[ -f "${zip}" ] || die "export did not produce a zip"
echo "sync-maps: got ${zip}" >&2

exec bash scripts/db-target.sh prod bash scripts/sync-maps.sh --inner "${zip}" "${email}" --apply
