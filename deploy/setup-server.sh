#!/usr/bin/env bash
#
# One-time onboarding of Gelp onto the shared platform k3s node.
#
# The node itself is owned and bootstrapped by the `platform` repo, NOT by this
# script anymore. Everything that used to live here — installing k3s/Traefik,
# disabling nm-cloud-setup/firewalld, the adnanh/webhook binary + systemd
# service + /etc/webhook/hooks.json, and cert-manager/TLS — is now provided
# once for the whole fleet by platform. This script only puts *this app* on a
# node the platform has already prepared: clone to /opt/gelp and run the first
# deploy. See the platform repo for the pieces this no longer does:
#
#   - node bootstrap (k3s + Traefik + podman) ...... platform bootstrap/bootstrap-node.sh
#   - webhook listener + deploy-gelp hook .......... platform webhook/hooks.json + bootstrap/install-webhook.sh
#   - wildcard *.lans-h.cc TLS (Traefik default) ... platform cluster/cert-manager/ (Gate 4)
#   - shared Postgres + gelp DB/role ............... platform cluster/data-postgres/provision-db.sh
#
# Idempotent: safe to re-run.
#
# Usage (as root, on the platform node):
#
#   sudo REPO_URL=https://github.com/you/gelp.git bash setup-server.sh
#
# The app host (gelp.lans-h.cc) is baked into the prod overlay, so no host
# variable is needed here.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Preconditions: root, required variables.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

if [ -z "${REPO_URL:-}" ]; then
  echo "ERROR: REPO_URL is not set." >&2
  echo "Usage: sudo REPO_URL=https://github.com/you/gelp.git bash setup-server.sh" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Clone the app repo to /opt/gelp. deploy.sh pulls on every webhook
#    delivery, so a shallow clone is all that's needed here.
# ---------------------------------------------------------------------------
if [ -d /opt/gelp/.git ]; then
  echo "==> /opt/gelp already cloned, skipping"
else
  echo "==> Cloning ${REPO_URL} to /opt/gelp"
  git clone --branch main --depth 1 "${REPO_URL}" /opt/gelp
fi

# ---------------------------------------------------------------------------
# 2. First deploy. Expected to warn (not fail) if the gelp-env Secret or the
#    shared Postgres don't exist yet — deploy.sh prints instructions and keeps
#    going, so this onboarding still finishes.
# ---------------------------------------------------------------------------
echo "==> Running first deploy (log: /var/log/gelp-first-deploy.log)"
bash /opt/gelp/deploy/deploy.sh 2>&1 | tee /var/log/gelp-first-deploy.log || true

# ---------------------------------------------------------------------------
# 3. What's left to do by hand (all in the platform repo, once per fleet).
# ---------------------------------------------------------------------------
cat <<'EOF'

############################################################
# Onboarding complete. Remaining steps live in the platform repo:
#
# 1. DB: provision gelp's database/role on the shared Postgres —
#      cluster/data-postgres/provision-db.sh (PROVISION_APPS="gelp").
#
# 2. Webhook: the deploy-gelp hook is defined in platform's
#      webhook/hooks.json and rendered by bootstrap/install-webhook.sh
#      (re-run with ALL app secrets — it renders the file wholesale).
#
# 3. App secret: create the gelp-env Secret (see the "Creating the
#      prod config" section of deploy/README.md), then:
#      sudo bash /opt/gelp/deploy/deploy.sh
#
# 4. GitHub webhook: Settings -> Webhooks -> Add webhook.
#      Payload URL:  http://deploy.lans-h.cc:9000/hooks/deploy-gelp
#      Content type: application/json
#      Secret:       the GELP_WEBHOOK_SECRET used by install-webhook.sh
#      Events:       just the push event
############################################################
EOF
