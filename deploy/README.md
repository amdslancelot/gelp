# Gelp deployment

This directory contains everything needed to build and run Gelp: the container
image definition, the Kubernetes manifests (a Kustomize base with `staging` and
`prod` overlays), the deploy scripts, and the GitHub webhook configuration.

Data lives in a **shared PostgreSQL** server in the `data` namespace — deployed
and owned by the **snoopy_home** repo (see its
`docs/PLAN-postgres-role-isolation.md`), not by gelp. Every app on the cluster
gets its own database and least-privilege role on it; gelp connects at
`postgres.data.svc:5432/gelp` as `gelp_rw`. Gelp's manifests only *connect* to
that server; `scripts/provision-db.sh` creates gelp's database/role on it once
per cluster.

## Layout

- `Dockerfile` — multi-stage build that produces the `gelp` runtime image from
  the Next.js standalone build output. No native toolchain (the database driver
  is pure-JS `pg`).
- `k8s/base/` — namespace-agnostic app manifests: Deployment, Service, Ingress
  (plain HTTP), and the nightly-import CronJob. Nothing here hardcodes a namespace
  or host. The database is not here — it is the shared Postgres in the `data`
  namespace, owned by snoopy_home.
- `k8s/overlays/staging/` — upstream Kubernetes (minikube), namespace
  `gelp-staging`, locally built image, `staging.localhost` ingress. The
  `gelp-env` Secret is created from your `.env` at deploy time (no secret YAML).
- `k8s/overlays/prod/` — k3s on the shared platform node, namespace `gelp`.
  **Live.** TLS is the platform's `*.lans-h.cc` wildcard cert (Traefik's default
  certificate) — the Ingress carries no `tls` block and no per-app cert-manager
  annotation. The `gelp-env` Secret is created from a server-local `.env.prod`.
- `stage.sh` — preflight-check the shared Postgres → build with podman → load
  into minikube → apply the staging app overlay → create `gelp-env` from `.env`.
  No registry, no Docker.
- `deploy.sh` — prod build-and-deploy on the node; run by the platform's shared
  webhook listener on every push to `main`, and safe to run by hand.
- `setup-server.sh` — one-time onboarding of gelp onto a node the **platform**
  repo has already bootstrapped (clone to /opt/gelp + first deploy). The node
  itself — k3s/Traefik, the webhook listener + `deploy-gelp` hook, cert-manager
  and the wildcard cert — is owned by the platform repo, not here.

## Staging (local Kubernetes)

Prereqs (one-time): a running minikube using a native driver, and Traefik for
ingress.

```sh
minikube start --driver=vfkit      # real upstream k8s, no Docker
helm repo add traefik https://traefik.github.io/charts && helm install traefik traefik/traefik
```

Then each deploy:

```sh
deploy/stage.sh
```

It checks the shared Postgres exists (`svc/postgres` in ns `data` — provisioned
by `snoopy_home/deploy/setup-minikube.sh`), builds `gelp:staging` with podman,
`podman save … | minikube image load -`, then
`kubectl apply -k deploy/k8s/overlays/staging` and **creates the `gelp-env`
Secret from your `.env`** (via `kubectl create secret --from-env-file`, with the
DB host and `AUTH_URL` rewritten for in-cluster). Reach the app with
`kubectl -n gelp-staging port-forward svc/gelp 3000:80` (then
<http://localhost:3000>), or via `minikube tunnel` on <http://staging.localhost>.

**Secrets are never committed**: they live only in your gitignored `.env` (dev
and staging share it). For Google sign-in on staging, add
`http://staging.localhost/api/auth/callback/google` as an authorized redirect
URI in the Google Cloud console.

## Manual prod deploy

On the node (repo checked out at `/opt/gelp`):

```sh
./deploy/deploy.sh
```

This pulls the latest commit, builds the image (docker or podman, whichever is
present) and imports it into k3s's containerd, applies the prod overlay
(`kubectl kustomize` — the host `gelp.lans-h.cc` is baked into the overlay, no
substitution), and rolls out the new image. TLS, the webhook listener, and the
shared Postgres are provided by the platform repo, not by this script.

## Creating the prod config

Prod's app config lives in a server-local **`.env.prod`**, gitignored — real
values never sit in a committed or duplicated YAML. On the server:

```sh
cp /opt/gelp/.env.prod.example /opt/gelp/.env.prod   # then fill in real values
```

The `gelp_rw` password in its `DATABASE_URL` must match what
`scripts/provision-db.sh` set on the prod shared Postgres
(`GELP_DB_PASSWORD=... scripts/provision-db.sh` on the server, once). `deploy.sh`
turns `.env.prod` into the `gelp-env` Secret with `kubectl create secret
--from-env-file`. The shared server's own superuser secret lives with its owner
(snoopy_home); gelp never touches it.

If `deploy.sh` finds neither `.env.prod` nor an existing cluster secret, it
prints a loud warning and continues; the pod stays unready until it exists.

## How the nightly import works

The `gelp-import` CronJob (`deploy/k8s/base/cronjob.yaml`) is scheduled for
03:30 server time nightly, and **ships suspended** (`suspend: true`). A small
`curlimages/curl` container `POST`s to `http://gelp/api/cron/import` — the app's
own Service, addressed namespace-relative so the same manifest works in any
namespace — with an `Authorization: Bearer $CRON_SECRET` header from the
`gelp-env` Secret and `--fail-with-body` so a non-2xx shows up as a failed Job.
`restartPolicy: Never` + a small `backoffLimit` mean a failing import retries a
few times then gives up; check `kubectl get jobs -n gelp` / `kubectl logs` on
the most recent `gelp-import-*` pod to debug.

**Why suspended.** The endpoint is a no-op until Drive sync is configured: it
returns `503 Drive sync is not configured` unless both
`GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` and `DRIVE_FOLDER_ID` are present in
`gelp-env`. Neither has ever been set in prod, so the job failed every night
from the day it was deployed and reported nothing else — noise that would drown
out a real import failure later.

**To enable:** add both variables to the server-local `/opt/gelp/.env.prod`
(step 3 of the root `README.md` covers minting the service-account key and
sharing the Drive folder with it), set `suspend: false` in
`deploy/k8s/base/cronjob.yaml`, and redeploy — `deploy.sh` rebuilds the Secret
from `.env.prod` and re-applies the manifest. Note that this single-tenant path
(one service account, one folder, importing for `allowedEmails()[0]`) is slated
for replacement by per-user Drive OAuth — see `TODO.md`, "Per-user nightly Drive
Takeout auto-sync" — which makes both variables obsolete.

## Automatic deploys

Deploys are driven by the **platform** repo's shared `adnanh/webhook` listener
(systemd service on port 9000): a signed push to `refs/heads/main` runs
`deploy.sh`. The `deploy-gelp` hook lives in the platform repo's
`webhook/hooks.json` (rendered onto the node by its
`bootstrap/install-webhook.sh`), and the GitHub webhook points at
`http://deploy.lans-h.cc:9000/hooks/deploy-gelp`.
