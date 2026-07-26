#!/usr/bin/env bash
#
# Builds and deploys Gelp to the local k3s cluster. Designed to be idempotent
# and safe to run both from the adnanh/webhook listener (on every push to
# main) and by hand on the server for a manual redeploy.
#
# Usage: deploy/deploy.sh   (no arguments)

set -euo pipefail

# k3s installs its binaries (k3s, and the kubectl/ctr symlinks) into
# /usr/local/bin. That is on the PATH for the webhook's systemd service and for
# an interactive root login, but NOT under `sudo bash deploy.sh`: sudo resets
# PATH to its secure_path, which excludes /usr/local/bin — so bare `k3s`/
# `kubectl` fail with "command not found" on a manual run. Prepend it so the
# script works identically whether the webhook or a human invokes it.
export PATH="/usr/local/bin:${PATH}"

# ---------------------------------------------------------------------------
# 0. Locate the repo root and load server-provided configuration.
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# kubectl needs no setup here: the webhook listener runs as root, and the
# platform repo's node bootstrap symlinks /root/.kube/config to the k3s
# kubeconfig (bootstrap/bootstrap-node.sh).

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
# 2. Build the image and import it directly into k3s's containerd, since
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

# Build and import under an explicit localhost/ name. The prod overlay's
# images transformer sets the pod spec to localhost/gelp:latest, and
# containerd treats "localhost" as the registry host — so it uses the imported
# local image directly, never normalizing a bare name to docker.io/library/
# and never attempting a registry pull. This is also exactly the name podman
# gives an unqualified build, so no retag is needed.
IMAGE="localhost/gelp:latest"
echo "==> Building ${IMAGE} with ${CONTAINER_TOOL}"
"${CONTAINER_TOOL}" build -f deploy/Dockerfile -t "${IMAGE}" .

echo "==> Importing ${IMAGE} into k3s containerd"
if [ "${CONTAINER_TOOL}" = "podman" ]; then
  podman save --format docker-archive "${IMAGE}" | k3s ctr images import -
else
  docker save "${IMAGE}" | k3s ctr images import -
fi

# ---------------------------------------------------------------------------
# 3. Preflight: the shared Postgres (namespace 'data') must already exist. It
#    is deployed and owned by the platform repo, not by gelp — gelp only
#    connects to it as gelp_rw.
# ---------------------------------------------------------------------------
echo "==> Preflight: shared Postgres Service in namespace 'data'"
if ! kubectl get svc postgres -n data >/dev/null 2>&1; then
  echo "##############################################################"
  echo "# WARNING: Service 'postgres' not found in namespace 'data'."
  echo "# The shared data plane is provisioned by the platform repo"
  echo "# (cluster/data-postgres/). The app will not become ready until"
  echo "# it exists. Continuing so the manifests are applied."
  echo "##############################################################"
fi

# ---------------------------------------------------------------------------
# 4. Apply the prod Kustomize overlay. The host is baked into the overlay
#    (gelp.lans-h.cc) — no placeholder substitution needed. The gelp-env
#    Secret is NOT part of the overlay: it is created from a server-local
#    .env.prod (real values live only there).
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

kubectl kustomize "${PROD_OVERLAY}" | kubectl apply -f -

# ---------------------------------------------------------------------------
# 5. Roll out the new image and wait for it to become healthy.
# ---------------------------------------------------------------------------
echo "==> Restarting deployment/gelp"
kubectl rollout restart deployment/gelp -n gelp
kubectl rollout status deployment/gelp -n gelp --timeout=180s

echo "==> Deploy complete"
