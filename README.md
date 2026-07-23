# Gelp

Gelp is a personal web app for browsing your Google Maps saved lists in a fast three-column UI: your lists on the left, the places of the selected list in the middle, and a map with category-filter chips on the right.

Google offers no API for saved lists, so Gelp imports a **Google Takeout "Saved" export** instead — either uploaded manually on the import page, or synced nightly from a Google Drive folder by a service account. Place categories and coordinates come from the Google Places API and are cached in Postgres, so each place costs **one** Places API call ever, across all re-imports. Google sign-in gates everything.

## Architecture

| Layer | Where | What |
|---|---|---|
| App | repo root (`app/`, `lib/`, …) | Next.js 15 (App Router, standalone output), NextAuth v5 Google sign-in, Drizzle over PostgreSQL (`pg`), Takeout-zip → Places-API → Postgres import pipeline, Leaflet map (OSM tiles, no client-side key) |
| Deploy | `deploy/` | Dockerfile, Kustomize k8s manifests (app base + `staging`/`prod` overlays for the app Deployment, Service, Ingress + Let's Encrypt, nightly import CronJob), `stage.sh`, `deploy.sh`, GitHub webhook config, and `setup-server.sh` — an idempotent bootstrap for the OCI Oracle Linux 9 ARM k3s host. The **shared Postgres data plane** (`data` namespace) is owned by the snoopy_home repo; gelp connects to it and provisions its own DB/role via `scripts/provision-db.sh` |

The app runs as a single container (`gelp`) built with podman and loaded into the target cluster's node image store — no image registry needed. **PostgreSQL is a shared in-cluster server in the `data` namespace** — one server per cluster, one database + least-privilege role per app (`gelp` / `gelp_rw`), deployed and owned by the **snoopy_home** repo (its `docs/PLAN-postgres-role-isolation.md` is the canonical multi-app plan). Gelp connects via `DATABASE_URL` at `postgres.data.svc:5432/gelp`. Environments: `npm run dev` locally (through a port-forward to the shared staging Postgres — dev has no database of its own), a `staging` overlay on the shared minikube, and a `prod` overlay on k3s.

## 1. Google Cloud setup

Everything lives in one GCP project (create one at <https://console.cloud.google.com>):

1. **OAuth client (sign-in).** APIs & Services → Credentials → Create credentials → OAuth client ID → Web application. Authorized redirect URIs: `http://localhost:3000/api/auth/callback/google` for local dev and `https://<your-host>/api/auth/callback/google` for production. Put the client ID/secret in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`. Set `ALLOWED_EMAILS` to your own email so only you can sign in.
2. **Places API key (enrichment).** Enable **Places API (New)**, create an API key restricted to it, and put it in `GOOGLE_MAPS_API_KEY`. It is only used server-side. If it is unset, imports still work — places just stay without coordinates/categories until you re-import with a key.
3. **Service account (nightly Drive sync, optional).** Create a service account, download its JSON key, and set `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` to `base64 -w0 key.json` (macOS: `base64 -i key.json`). Create a Drive folder, **share it with the service account's email** (viewer is enough), and put the folder ID (the part after `/folders/` in its URL) in `DRIVE_FOLDER_ID`.

## 2. Getting your Takeout export

1. Go to <https://takeout.google.com>, deselect all, select only **Saved** (your Maps saved lists), and export.
2. **Manual path:** download the zip and upload it on Gelp's `/import` page.
3. **Automatic path:** choose "Add to Drive" as the delivery method (or set up a scheduled export every 2 months) targeting the shared Drive folder from step 1.3. The in-cluster CronJob hits `POST /api/cron/import` nightly at 03:30; the app then pulls the newest `takeout*.zip` from that folder and imports it. You can trigger it manually any time:

   ```sh
   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<your-host>/api/cron/import
   ```

Re-imports are idempotent: each list is replaced wholesale, and the place cache means already-seen places cost zero API calls.

## 3. Development & staging

Three environments share one image and one database engine (`postgres:17`):
**dev** (`npm run dev` on your machine), **staging** (the container on a local
Kubernetes cluster), and **prod** (k3s on OCI, section 4). Dev and staging are
covered here.

### Prerequisites

- **Node 22+** and **npm**.
- **[podman](https://podman.io/)** with its machine started: `podman machine start`
  (used to build container images; dev no longer runs its own database container).
- The **shared minikube cluster** with the `data`-namespace Postgres, provisioned
  by the **snoopy_home** repo: `snoopy_home/deploy/setup-minikube.sh`. That repo
  owns the shared data plane in both clusters — see its
  `docs/PLAN-postgres-role-isolation.md`.

No Docker anywhere — every container command uses podman.

### One-time: provision gelp on the shared Postgres

Each cluster's shared server needs gelp's database and role created once
(`gelp` owned by LOGIN-only `gelp_rw`, `REVOKE CONNECT … FROM PUBLIC` so no other
app's role can reach it). With the password already in `.env`'s `DATABASE_URL`:

```sh
scripts/provision-db.sh        # runs against the current kubectl context
```

The script is idempotent and finishes with the isolation checks from the
canonical plan (own DB connects; `snoopy_home` refused; role has no
superuser/CREATEDB/CREATEROLE).

### Dev (`npm run dev`)

Dev has **no database of its own** — it connects to the shared staging Postgres
inside minikube through a port-forward, so dev and the staged app deliberately
see the same data.

```sh
cp .env.example .env          # fill in AUTH_* and the gelp_rw password
npm install
npm run db:up                 # background port-forward: localhost:5432 -> svc/postgres in ns data
npm run dev                   # http://localhost:3000
```

- `npm run db:up` runs `scripts/db-forward.sh start` (idempotent; no-op if
  something already answers on `localhost:5432`). `npm run db:down` stops it.
- The schema auto-migrates on the app's first database request; there is no
  separate migrate step.
- Because dev and staging share one database: avoid running a dev import and the
  staging import CronJob at the same moment.

Verify the whole import pipeline offline — no network, no API keys — against the
shared server (it creates and drops a throwaway database, never touching your
`gelp` data). CREATE/DROP DATABASE needs the `postgres` superuser, so this uses
`SELFCHECK_ADMIN_URL` (default: the runbook's `dev` password) rather than
`DATABASE_URL`:

```sh
npm run selfcheck
# or, with a non-default superuser password:
SELFCHECK_ADMIN_URL="postgres://postgres:<pw>@localhost:5432/postgres" npm run selfcheck
```

### Migrating existing SQLite data

If you have a pre-Postgres `data/gelp.db`, copy its rows across once (with the
port-forward up). This does **not** happen automatically:

```sh
SQLITE_PATH=data/gelp.db DATABASE_URL="postgres://gelp_rw:<pw>@localhost:5432/gelp" \
  npm run db:migrate-data
```

It creates the schema, loads users → place_cache → lists → places in
foreign-key-safe order, is idempotent (safe to re-run), and verifies every source
row is present in the target by primary key.

### Staging (local Kubernetes)

Staging runs the real container image on the **shared minikube cluster** (the
same one snoopy's staging uses — provisioned by `snoopy_home/deploy/setup-minikube.sh`,
podman driver), connecting to the same shared `data`-namespace Postgres as dev.
For ingress on `staging.localhost`, install Traefik once
(`helm install traefik traefik/traefik`) — or skip ingress and just port-forward.

No secret file to create: staging shares your `.env`. Each deploy:

```sh
deploy/stage.sh
```

`stage.sh` checks the shared Postgres exists (it does not deploy one), builds
`gelp:staging` with podman, streams it into minikube (`podman save … | minikube
image load -`, no registry), applies the `staging` app overlay, **creates the
`gelp-env` Secret from your `.env`** (rewriting just the two vars that differ
in-cluster — the DB host and `AUTH_URL`), and waits for the app in
`gelp-staging` to become ready. Real values live only in `.env` — never in a
committed or duplicated YAML.

Reach the app:

```sh
# simplest: port-forward
kubectl -n gelp-staging port-forward svc/gelp 3000:80   # then http://localhost:3000

# or via the ingress host: run `minikube tunnel` in another terminal, add
#   127.0.0.1 staging.localhost
# to /etc/hosts, then open http://staging.localhost
```

Notes:

- **Secrets are never committed** — they live only in gitignored `.env` files,
  and the `gelp-env` Secret is created from them at deploy time (snoopy_home's
  policy: no passwords in files except the `*.example` templates). Google
  sign-in on staging needs `http://staging.localhost/api/auth/callback/google`
  added as an authorized redirect URI in the Google Cloud console.
- Inspect / debug: `kubectl -n gelp-staging get pods`,
  `kubectl -n gelp-staging logs deploy/gelp`.
- Tear down: `kubectl delete ns gelp-staging` (or `minikube stop` to pause the
  whole cluster).

## 4. Server setup (existing OCI instance, Oracle Linux 9 ARM)

Prerequisites: an existing OCI ARM instance (e.g. always-free VM.Standard.A1.Flex) running Oracle Linux 9 with a public IP, SSH access as a sudo-capable user (usually `opc`), and a fork/copy of this repo on GitHub (the server clones it and GitHub pushes trigger deploys).

First, in the OCI console, open the ports the stack needs: in the instance subnet's **security list / NSG**, allow ingress TCP **22, 80, 443, and 9000** (the webhook listener; you can restrict 9000 to GitHub's hook IP ranges from <https://api.github.com/meta> if you like). The bootstrap disables the host firewall per the k3s docs, so the security list is the only packet filter — a port not open there is unreachable.

Then run the bootstrap script on the instance:

```sh
scp deploy/setup-server.sh opc@<public-ip>:
ssh opc@<public-ip>
sudo GELP_HOST=gelp.example.com \
     LETSENCRYPT_EMAIL=you@example.com \
     WEBHOOK_SECRET="$(openssl rand -hex 32)" \
     REPO_URL=https://github.com/you/gelp.git \
     bash setup-server.sh
```

On a stock OCI image the first run stops after disabling `nm-cloud-setup` and asks you to **reboot and re-run** (a k3s requirement); the script is idempotent, so just run it again with the same variables after the reboot. It installs podman and k3s (with Traefik and local-path storage), clones the repo to `/opt/gelp`, starts the webhook listener on port 9000, and runs the first deploy. Keep the `WEBHOOK_SECRET` value — you'll need it in step 3. Then:

1. **DNS:** point `GELP_HOST` (an A record) at the instance's public IP.
2. **Provision + app config:** SSH in, then:
   - **Provision gelp's DB/role** on the shared `data`-namespace Postgres (owned by snoopy_home; must already be running), once: `GELP_DB_PASSWORD="$(openssl rand -hex 24)" bash /opt/gelp/scripts/provision-db.sh` (keep the password for the next step).
   - **App config** (`.env.prod`): copy `/opt/gelp/.env.prod.example` to `/opt/gelp/.env.prod` (gitignored), fill in real values; the `DATABASE_URL` password must be the `GELP_DB_PASSWORD` from the provisioning step. `deploy/deploy.sh` turns it into the `gelp-env` Secret — real values never leave that file. Then:

   ```sh
   sudo bash /opt/gelp/deploy/deploy.sh
   ```

3. **Push-to-deploy:** in the GitHub repo, Settings → Webhooks → Add webhook. Payload URL `http://<public-ip>:9000/hooks/deploy`, content type `application/json`, secret = the `WEBHOOK_SECRET` you passed to `setup-server.sh`, events: just pushes. Every push to `main` then rebuilds the image on the server and rolls the deployment.

Let's Encrypt certificates are issued automatically by cert-manager once DNS resolves to the instance.

## 5. Repo map

```
app/                  Next.js routes (three-column UI at /, /import, /login, API routes)
lib/                  Takeout parser, import pipeline, Places client, Drive sync, Drizzle schema
drizzle/              generated SQL migrations (applied automatically at startup)
scripts/selfcheck.ts  offline end-to-end check of the import pipeline
deploy/               Dockerfile, Kustomize k8s (base + staging/prod overlays), stage.sh, deploy.sh, setup-server.sh, webhook config
.env.example          every environment variable, documented
```
