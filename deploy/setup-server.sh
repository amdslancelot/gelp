#!/usr/bin/env bash
#
# One-time bootstrap of an EXISTING Oracle Linux 9 ARM (aarch64) instance so
# it can build and serve Gelp on a single-node k3s cluster with push-to-deploy.
# It replaces the Terraform/cloud-init provisioning this repo used to ship:
# run it once over SSH on a box you already have, instead of creating one.
#
# The script is idempotent: every step checks before it acts, so re-running
# it is always safe. That matters because on stock OCI Oracle Linux images it
# will stop early once, on purpose: k3s requires nm-cloud-setup to be
# disabled *followed by a reboot* (https://docs.k3s.io/installation/requirements),
# so the first run disables it and asks you to reboot and run the script again.
#
# Usage (as root, or via sudo with the variables on the command line):
#
#   sudo GELP_HOST=gelp.example.com \
#        LETSENCRYPT_EMAIL=you@example.com \
#        WEBHOOK_SECRET="$(openssl rand -hex 32)" \
#        REPO_URL=https://github.com/you/gelp.git \
#        bash setup-server.sh
#
# The script is standalone: scp just this file to the instance and run it —
# it clones the repo to /opt/gelp itself.
#
# Not covered here (do these in the OCI console / your DNS provider):
#   - The subnet's security list / NSG must allow ingress TCP 22, 80, 443,
#     and 9000. This script disables the host firewall (firewalld), so the
#     OCI security list is the ONLY packet filter in front of the instance —
#     a port must be open there or the service is unreachable.
#   - An A record for GELP_HOST pointing at the instance's public IP.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Preconditions: root, required variables, expected platform.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: this script must run as root (use sudo)." >&2
  exit 1
fi

missing=0
for var in GELP_HOST LETSENCRYPT_EMAIL WEBHOOK_SECRET REPO_URL; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: $var is not set." >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "Usage: sudo GELP_HOST=... LETSENCRYPT_EMAIL=... WEBHOOK_SECRET=... REPO_URL=... bash setup-server.sh" >&2
  exit 1
fi

# The rendering step below reads WEBHOOK_SECRET from the environment (not
# argv) so the secret never shows up in `ps` output; make sure it is exported
# even if the caller only set it as a shell variable.
export WEBHOOK_SECRET

# Everything downstream (webhook binary arch, k3s-selinux, dnf) assumes an
# aarch64 Oracle Linux 9 host. Warn rather than fail on a mismatch, since a
# close-enough RHEL 9 derivative will usually still work.
if [ "$(uname -m)" != "aarch64" ]; then
  echo "WARNING: expected aarch64, found $(uname -m) — the webhook binary download below is arm64-only." >&2
fi
if [ ! -f /etc/oracle-release ]; then
  echo "WARNING: /etc/oracle-release not found — this script is written for Oracle Linux 9; proceeding anyway." >&2
fi

# ---------------------------------------------------------------------------
# 1. Packages. podman (from OL9's own AppStream repo) is the image build
#    tool — deploy.sh auto-detects it. container-selinux is the policy
#    package the k3s-selinux RPM depends on; SELinux stays enforcing.
#    gettext provides envsubst, which deploy.sh needs to render the
#    ClusterIssuer and Ingress manifests on every deploy.
# ---------------------------------------------------------------------------
echo "==> Installing packages (git, curl, jq, tar, gettext, podman, container-selinux, policycoreutils)"
dnf -y install git curl jq tar gettext podman container-selinux policycoreutils

# ---------------------------------------------------------------------------
# 2. nm-cloud-setup. k3s's documented requirement on RHEL-family cloud
#    images: disable nm-cloud-setup and reboot before installing k3s. OCI
#    Oracle Linux images ship it enabled. On a single-VNIC instance this is
#    safe (nm-cloud-setup only matters for secondary VNIC configuration).
#    Because the reboot is mandatory, the first run stops here; re-running
#    the script after the reboot continues past this block.
# ---------------------------------------------------------------------------
needs_reboot=0
for unit in nm-cloud-setup.service nm-cloud-setup.timer; do
  if systemctl is-enabled "$unit" >/dev/null 2>&1; then
    echo "==> Disabling $unit (required by k3s)"
    systemctl disable --now "$unit"
    needs_reboot=1
  fi
done
if [ "$needs_reboot" -ne 0 ]; then
  echo ""
  echo "############################################################"
  echo "# nm-cloud-setup has been disabled. A reboot is REQUIRED"
  echo "# before k3s can be installed (per the k3s docs)."
  echo "#"
  echo "#   1. sudo reboot"
  echo "#   2. re-run this script with the same variables"
  echo "#"
  echo "# The script is idempotent; the second run picks up here."
  echo "############################################################"
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. firewalld. The k3s docs recommend disabling it (its default rules
#    conflict with k3s networking). Perimeter filtering is the OCI security
#    list's job — see the header. If you would rather keep firewalld, skip
#    this step and instead run:
#      firewall-cmd --permanent --add-port={80,443,9000,6443}/tcp
#      firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16
#      firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16
#      firewall-cmd --reload
# ---------------------------------------------------------------------------
if systemctl is-enabled firewalld >/dev/null 2>&1; then
  echo "==> Disabling firewalld (k3s docs recommendation; OCI security list filters instead)"
  systemctl disable --now firewalld
fi

# ---------------------------------------------------------------------------
# 4. k3s, via the official install script. Keeps the default Traefik ingress
#    controller and local-path storage provisioner, which the manifests in
#    deploy/k8s rely on. On an SELinux-enforcing RHEL-family host the script
#    installs the k3s-selinux policy RPM automatically.
# ---------------------------------------------------------------------------
if command -v k3s >/dev/null 2>&1; then
  echo "==> k3s already installed, skipping install"
else
  echo "==> Installing k3s"
  curl -sfL https://get.k3s.io | sh -
fi

echo "==> Waiting for the k3s node to be Ready"
for i in $(seq 1 60); do
  if /usr/local/bin/k3s kubectl get nodes 2>/dev/null | grep -q ' Ready '; then
    break
  fi
  echo "    waiting for k3s node to be Ready (${i}/60)..."
  sleep 5
done

# Make kubectl usable in ad-hoc root shells; deploy.sh sets KUBECONFIG itself
# via deploy.env, this just covers interactive use.
mkdir -p /root/.kube
ln -sf /etc/rancher/k3s/k3s.yaml /root/.kube/config
chmod 600 /etc/rancher/k3s/k3s.yaml

# ---------------------------------------------------------------------------
# 5. Clone the app repo to /opt/gelp. deploy.sh pulls on every webhook
#    delivery, so a shallow clone is all that's needed here.
# ---------------------------------------------------------------------------
if [ -d /opt/gelp/.git ]; then
  echo "==> /opt/gelp already cloned, skipping"
else
  echo "==> Cloning ${REPO_URL} to /opt/gelp"
  git clone --branch main --depth 1 "${REPO_URL}" /opt/gelp
fi

# ---------------------------------------------------------------------------
# 6. deploy.env — the contract deploy.sh sources on every run. It lives
#    outside the git checkout's tracked files, so git pulls never touch it.
# ---------------------------------------------------------------------------
echo "==> Writing /opt/gelp/deploy.env"
install -o root -g root -m 0600 /dev/null /opt/gelp/deploy.env
cat > /opt/gelp/deploy.env <<EOF
GELP_HOST=${GELP_HOST}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL}
KUBECONFIG=/etc/rancher/k3s/k3s.yaml
EOF

# ---------------------------------------------------------------------------
# 7. adnanh/webhook binary (linux-arm64). Pinned; re-running upgrades only
#    when the pin changes.
# ---------------------------------------------------------------------------
WEBHOOK_VERSION="2.8.3"
if /usr/local/bin/webhook -version 2>/dev/null | grep -q "${WEBHOOK_VERSION}"; then
  echo "==> webhook ${WEBHOOK_VERSION} already installed, skipping download"
else
  echo "==> Installing adnanh/webhook ${WEBHOOK_VERSION}"
  curl -sfL -o /tmp/webhook.tar.gz \
    "https://github.com/adnanh/webhook/releases/download/${WEBHOOK_VERSION}/webhook-linux-arm64.tar.gz"
  rm -rf /tmp/webhook-extract
  mkdir -p /tmp/webhook-extract
  tar -xzf /tmp/webhook.tar.gz -C /tmp/webhook-extract
  install -o root -g root -m 0755 /tmp/webhook-extract/webhook-linux-arm64/webhook /usr/local/bin/webhook
  restorecon /usr/local/bin/webhook
  rm -rf /tmp/webhook.tar.gz /tmp/webhook-extract
fi

# ---------------------------------------------------------------------------
# 8. Render /etc/webhook/hooks.json from the checked-in template. The
#    template ships with a literal {{WEBHOOK_SECRET}} placeholder; the real
#    secret is substituted here via jq reading the environment, so it never
#    appears in a process argument list and never touches a git-tracked
#    file (a redeploy's git pull would revert an in-place edit anyway).
#    Rendering goes to a temp file first so an unchanged re-run leaves the
#    live config untouched (and the listener unbounced, see step 9).
# ---------------------------------------------------------------------------
echo "==> Rendering /etc/webhook/hooks.json"
mkdir -p /etc/webhook
webhook_config_changed=0
jq 'walk(if . == "{{WEBHOOK_SECRET}}" then env.WEBHOOK_SECRET else . end)' \
  /opt/gelp/deploy/webhook/hooks.json > /etc/webhook/hooks.json.new
jq -e . /etc/webhook/hooks.json.new >/dev/null
if ! cmp -s /etc/webhook/hooks.json.new /etc/webhook/hooks.json; then
  install -o root -g root -m 0600 /etc/webhook/hooks.json.new /etc/webhook/hooks.json
  webhook_config_changed=1
fi
rm -f /etc/webhook/hooks.json.new

# ---------------------------------------------------------------------------
# 9. systemd unit for the webhook listener (port 9000). The unit is only
#    (re)written when its content differs, and the service is only
#    restarted when the unit or the rendered hooks.json changed — an
#    unchanged re-run must not bounce a listener that might be serving an
#    in-flight webhook delivery.
# ---------------------------------------------------------------------------
echo "==> Installing webhook.service"
cat > /tmp/webhook.service.new <<'EOF'
[Unit]
Description=adnanh/webhook listener for Gelp push-to-deploy
After=network-online.target k3s.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/webhook -hooks /etc/webhook/hooks.json -port 9000 -verbose
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF
if ! cmp -s /tmp/webhook.service.new /etc/systemd/system/webhook.service; then
  install -o root -g root -m 0644 /tmp/webhook.service.new /etc/systemd/system/webhook.service
  systemctl daemon-reload
  webhook_config_changed=1
fi
rm -f /tmp/webhook.service.new
systemctl enable --now webhook.service
if [ "${webhook_config_changed}" -ne 0 ]; then
  systemctl restart webhook.service
fi

# ---------------------------------------------------------------------------
# 10. First deploy. Expected to fail gracefully if the gelp-env Kubernetes
#     Secret doesn't exist yet — deploy.sh prints instructions for creating
#     it and keeps going, so this bootstrap still finishes.
# ---------------------------------------------------------------------------
echo "==> Running first deploy (log: /var/log/gelp-first-deploy.log)"
bash /opt/gelp/deploy/deploy.sh 2>&1 | tee /var/log/gelp-first-deploy.log || true

# ---------------------------------------------------------------------------
# 11. What's left to do by hand.
# ---------------------------------------------------------------------------
cat <<EOF

############################################################
# Bootstrap complete. Remaining manual steps:
#
# 1. OCI console: allow ingress TCP 22, 80, 443, 9000 in the
#    subnet's security list / NSG (firewalld is disabled, so
#    the security list is the only packet filter).
#
# 2. DNS: point an A record for ${GELP_HOST} at this
#    instance's public IP. cert-manager issues the Let's
#    Encrypt certificate once it resolves.
#
# 3. App secrets: create the gelp-env Secret (see the
#    "Creating the app secret" section of deploy/README.md),
#    then run:  sudo bash /opt/gelp/deploy/deploy.sh
#
# 4. GitHub: Settings -> Webhooks -> Add webhook.
#    Payload URL:  http://<this-instance-public-ip>:9000/hooks/deploy
#    Content type: application/json
#    Secret:       the WEBHOOK_SECRET value you passed in
#    Events:       just pushes
#    Every push to main then redeploys automatically.
############################################################
EOF
