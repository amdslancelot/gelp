#!/usr/bin/env bash
#
# Build the Gelp image with podman, load it into the local minikube cluster,
# and deploy the staging overlay. No registry, no Docker.
#
# Prereqs (one-time):
#   minikube start --driver=vfkit           # real upstream k8s, no Docker
#   minikube addons enable ...  OR install Traefik via Helm for ingress
# Then, each deploy:
#   deploy/stage.sh
#
# Reach the app with `kubectl -n gelp-staging port-forward svc/gelp 3000:80`
# (then http://localhost:3000), or via Traefik + `minikube tunnel` on
# http://staging.localhost.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

IMAGE="gelp:staging"

# The shared Postgres in the `data` namespace is deployed and owned by the
# snoopy_home repo (its deploy/setup-minikube.sh); gelp only connects to it.
echo "==> Preflight: shared Postgres Service in namespace 'data'"
if ! kubectl get svc postgres -n data >/dev/null 2>&1; then
  echo "ERROR: Service 'postgres' not found in namespace 'data'." >&2
  echo "The shared data plane is provisioned by the snoopy_home repo:" >&2
  echo "  snoopy_home/deploy/setup-minikube.sh" >&2
  exit 1
fi

echo "==> Building ${IMAGE} with podman"
podman build -f deploy/Dockerfile -t "${IMAGE}" .

echo "==> Loading ${IMAGE} into minikube"
# podman save streams a docker-archive that `minikube image load` accepts on
# stdin, so nothing touches a registry.
podman save "${IMAGE}" | minikube image load -

echo "==> Applying staging app overlay"
kubectl apply -k deploy/k8s/overlays/staging

# The gelp-env Secret is created from the local .env at deploy time, so real
# values live only there — never in a committed or duplicated YAML. Dev and
# staging share one .env; the only staging-specific rewrites are the two non-
# secret vars that differ in-cluster: the DB host (the dev port-forward's
# localhost becomes the in-cluster Service) and the app's public URL.
if [ -f "${REPO_ROOT}/.env" ]; then
  echo "==> Creating gelp-env Secret from .env (staging overrides applied)"
  STAGING_ENV="$(mktemp)"
  trap 'rm -f "${STAGING_ENV}"' EXIT
  sed -e 's#@localhost:5432/gelp#@postgres.data.svc:5432/gelp#' \
      -e 's#^AUTH_URL=.*#AUTH_URL=http://staging.localhost#' \
      "${REPO_ROOT}/.env" > "${STAGING_ENV}"
  kubectl create secret generic gelp-env \
    --namespace gelp-staging \
    --from-env-file="${STAGING_ENV}" \
    --dry-run=client -o yaml | kubectl apply -f -
  rm -f "${STAGING_ENV}"
  trap - EXIT
elif kubectl get secret gelp-env -n gelp-staging >/dev/null 2>&1; then
  echo "==> No .env found; leaving the existing gelp-env Secret as-is"
else
  echo "WARNING: no ${REPO_ROOT}/.env and no gelp-env Secret in the cluster." >&2
  echo "Copy .env.example to .env and fill it in; the app won't start without it." >&2
fi

echo "==> Waiting for the app to become ready"
kubectl rollout status deployment/gelp -n gelp-staging --timeout=180s

echo "==> Staging deploy complete"
