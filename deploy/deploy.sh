#!/usr/bin/env bash
#
# Builds and deploys Gelp to the local k3s cluster. Designed to be idempotent
# and safe to run both from the adnanh/webhook listener (on every push to
# main) and by hand on the server for a manual redeploy.
#
# Usage: deploy/deploy.sh   (no arguments)

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Locate the repo root and load server-provided configuration.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# /opt/gelp/deploy.env is written by deploy/setup-server.sh on the server
# and supplies GELP_HOST, LETSENCRYPT_EMAIL, and KUBECONFIG. It won't exist
# when this script is run outside that server (e.g. a developer laptop), so
# tolerate its absence rather than failing.
if [ -f /opt/gelp/deploy.env ]; then
  # shellcheck disable=SC1091
  source /opt/gelp/deploy.env
fi

cd "${REPO_ROOT}"

echo "==> Deploying Gelp from ${REPO_ROOT}"

# ---------------------------------------------------------------------------
# 1. Pull the latest code, but only when this checkout is actually a git repo
#    with an "origin" remote configured (a fresh manual clone or archive
#    extraction may not be, and forcing a pull there would just fail).
# ---------------------------------------------------------------------------
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && git remote get-url origin >/dev/null 2>&1; then
  echo "==> Pulling latest changes (git pull --ff-only)"
  git pull --ff-only
else
  echo "==> Skipping git pull (not a git repo with an origin remote)"
fi

# ---------------------------------------------------------------------------
# 2. Install cert-manager if it isn't already present in the cluster.
# ---------------------------------------------------------------------------
CERT_MANAGER_VERSION="v1.15.3"
CERT_MANAGER_MANIFEST="https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"

if kubectl get ns cert-manager >/dev/null 2>&1; then
  echo "==> cert-manager namespace already exists, skipping install"
else
  echo "==> Installing cert-manager ${CERT_MANAGER_VERSION}"
  kubectl apply -f "${CERT_MANAGER_MANIFEST}"
  echo "==> Waiting for cert-manager deployments to become available"
  kubectl wait --for=condition=Available --timeout=180s \
    deployment/cert-manager \
    deployment/cert-manager-webhook \
    deployment/cert-manager-cainjector \
    -n cert-manager
fi

# ---------------------------------------------------------------------------
# 3. Build the image and import it directly into k3s's containerd, since
#    there is no registry in this setup (imagePullPolicy: IfNotPresent in the
#    Deployment relies on the image already being present locally). The
#    build tool is auto-detected: docker on Ubuntu-style hosts, podman on
#    RHEL-family hosts (e.g. Oracle Linux 9, where podman ships in the
#    distro's own repos). podman needs --format docker-archive on save
#    because its default oci-archive output is not what `ctr images import`
#    expects for a docker-tagged image.
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  CONTAINER_TOOL=docker
elif command -v podman >/dev/null 2>&1; then
  CONTAINER_TOOL=podman
else
  echo "ERROR: neither docker nor podman found; install one to build the image" >&2
  exit 1
fi

echo "==> Building gelp:latest with ${CONTAINER_TOOL}"
"${CONTAINER_TOOL}" build -f deploy/Dockerfile -t gelp:latest .

echo "==> Importing gelp:latest into k3s containerd"
if [ "${CONTAINER_TOOL}" = "podman" ]; then
  podman save --format docker-archive gelp:latest | k3s ctr images import -
else
  docker save gelp:latest | k3s ctr images import -
fi

# ---------------------------------------------------------------------------
# 4. Preflight: the shared Postgres (namespace 'data') must already exist. It
#    is deployed and owned by the snoopy_home repo (its prod k3s runbook), not
#    by gelp — gelp only connects to it as gelp_rw.
# ---------------------------------------------------------------------------
echo "==> Preflight: shared Postgres Service in namespace 'data'"
if ! kubectl get svc postgres -n data >/dev/null 2>&1; then
  echo "##############################################################"
  echo "# WARNING: Service 'postgres' not found in namespace 'data'."
  echo "# The shared data plane is provisioned by the snoopy_home repo"
  echo "# (docs/prod-k3s-runbook.md). The app will not become ready"
  echo "# until it exists. Continuing so the manifests are applied."
  echo "##############################################################"
fi

# ---------------------------------------------------------------------------
# 5. Apply the prod Kustomize overlay. The rendered manifests contain
#    ${GELP_HOST}/${LETSENCRYPT_EMAIL} placeholders (in the Ingress and
#    ClusterIssuer) that need shell substitution before they're valid for
#    kubectl. The gelp-env Secret is NOT part of the overlay: it is created from
#    a server-local .env.prod (real values live only there).
# ---------------------------------------------------------------------------
PROD_OVERLAY="${SCRIPT_DIR}/k8s/overlays/prod"
echo "==> Applying prod overlay from ${PROD_OVERLAY}"

# Ensure the namespace exists before the secret is created into it.
kubectl apply -f "${PROD_OVERLAY}/namespace.yaml"

PROD_ENV="${REPO_ROOT}/.env.prod"
if [ -f "${PROD_ENV}" ]; then
  echo "==> Creating gelp-env Secret from .env.prod"
  kubectl create secret generic gelp-env \
    --namespace gelp \
    --from-env-file="${PROD_ENV}" \
    --dry-run=client -o yaml | kubectl apply -f -
elif kubectl get secret gelp-env -n gelp >/dev/null 2>&1; then
  echo "==> Secret gelp-env already exists, leaving it as-is"
else
  echo "##############################################################"
  echo "# WARNING: the gelp-env secret is missing and no"
  echo "# ${PROD_ENV} was found. The app will not start until it exists."
  echo "# Copy .env.prod.example to .env.prod, fill in real values, then"
  echo "# re-run this script. Continuing deployment without it."
  echo "##############################################################"
fi

# shellcheck disable=SC2016  # envsubst takes the ${VAR} names literally
kubectl kustomize "${PROD_OVERLAY}" \
  | envsubst '${GELP_HOST} ${LETSENCRYPT_EMAIL}' \
  | kubectl apply -f -

# ---------------------------------------------------------------------------
# 6. Roll out the new image and wait for it to become healthy.
# ---------------------------------------------------------------------------
echo "==> Restarting deployment/gelp"
kubectl rollout restart deployment/gelp -n gelp
kubectl rollout status deployment/gelp -n gelp --timeout=180s

echo "==> Deploy complete"
