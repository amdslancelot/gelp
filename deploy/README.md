# Gelp deployment

This directory contains everything needed to build and run Gelp on the
production server: the container image definition, the Kubernetes manifests
for the single-node k3s cluster, the deploy script, and the GitHub webhook
configuration that triggers it automatically.

## Layout

- `Dockerfile` — multi-stage build that produces the `gelp:latest` runtime
  image from the Next.js standalone build output.
- `k8s/` — numbered Kubernetes manifests, applied in order by `deploy.sh`:
  namespace, cert-manager ClusterIssuer, Secret template, PVC, Deployment,
  Service, Ingress, and the nightly import CronJob.
- `deploy.sh` — idempotent build-and-deploy script; run by the webhook on
  every push to `main`, and safe to run by hand at any time.
- `setup-server.sh` — one-time root bootstrap of an existing Oracle Linux 9
  ARM host: packages, podman, k3s, the webhook systemd service, the repo
  clone at `/opt/gelp`, and the first deploy. See section 4 of the root
  README for the full walkthrough.
- `webhook/` — `adnanh/webhook` configuration that runs `deploy.sh` when
  GitHub delivers a push event to `main`.

## Manual deploy

On the server (where the repo is checked out at `/opt/gelp`):

```sh
./deploy/deploy.sh
```

This pulls the latest commit (if running inside a git checkout with an
`origin` remote), installs cert-manager on first run, builds the container
image (with docker or podman, whichever is installed), imports it into
k3s's containerd, applies all manifests, and rolls out the new image,
waiting until the Deployment reports healthy.

## Creating the app secret

The app's environment variables (Auth.js secrets, Google OAuth/Maps/Drive
credentials, the cron bearer token, etc.) are supplied by the Kubernetes
Secret `gelp-env`, which is deliberately **not** committed to this
repository. To create it:

1. Copy `deploy/k8s/20-secret.example.yaml` to `deploy/k8s/20-secret.yaml`
   (the latter is gitignored via `deploy/k8s/.gitignore`).
2. Fill in real values for every placeholder.
3. Either let the next run of `deploy.sh` apply it automatically, or apply it
   yourself right away:

   ```sh
   kubectl apply -f deploy/k8s/20-secret.yaml
   ```

If `deploy.sh` runs and finds neither a local `20-secret.yaml` nor an
existing `gelp-env` Secret in the cluster, it prints a loud warning with the
exact command above and continues anyway, since the rest of the stack (PVC,
Service, Ingress, CronJob) can still be applied without it — only the app
pod itself will fail to become ready until the secret exists.

## How the nightly import works

The `gelp-import` CronJob (`deploy/k8s/70-cronjob.yaml`) runs at 03:30 server
time every night. It uses a small `curlimages/curl` container to `POST` to
`http://gelp.gelp.svc.cluster.local/api/cron/import` — the app's own Service
address inside the cluster — with an `Authorization: Bearer $CRON_SECRET`
header sourced from the `gelp-env` Secret, and `--fail-with-body` so a
non-2xx response shows up as a failed Job with the response body in the pod
logs. `restartPolicy: Never` and a small `backoffLimit` mean a failing import
creates a few retry Pods and then gives up rather than retrying forever;
check `kubectl get jobs -n gelp` / `kubectl logs` on the most recent
`gelp-import-*` pod to debug a failure.

## Automatic deploys

`webhook/hooks.json` configures `adnanh/webhook` (already running as a
systemd service on the server, port 9000) to run `deploy.sh` whenever GitHub
delivers a signed push event to `refs/heads/main`. See `webhook/README.md`
for how to point the GitHub repository's webhook at this listener.
