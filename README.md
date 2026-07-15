# Gelp

Gelp is a personal web app for browsing your Google Maps saved lists in a fast three-column UI: your lists on the left, the places of the selected list in the middle, and a map with category-filter chips on the right.

Google offers no API for saved lists, so Gelp imports a **Google Takeout "Saved" export** instead — either uploaded manually on the import page, or synced nightly from a Google Drive folder by a service account. Place categories and coordinates come from the Google Places API and are cached in SQLite, so each place costs **one** Places API call ever, across all re-imports. Google sign-in gates everything.

## Architecture

| Layer | Where | What |
|---|---|---|
| App | repo root (`app/`, `lib/`, …) | Next.js 15 (App Router, standalone output), NextAuth v5 Google sign-in, Drizzle over SQLite (better-sqlite3), Takeout-zip → Places-API → SQLite import pipeline, Leaflet map (OSM tiles, no client-side key) |
| Deploy | `deploy/` | Dockerfile, k8s manifests (Deployment, Service, Ingress + Let's Encrypt, nightly import CronJob), `deploy.sh`, GitHub webhook config, and `setup-server.sh` — a one-time bootstrap that turns an existing OCI Oracle Linux 9 ARM instance into a single-node k3s host with push-to-deploy |

The app runs as a single container (`gelp:latest`) built directly on the server and imported into k3s — no image registry needed. SQLite lives on a PersistentVolumeClaim mounted at `/data`.

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

## 3. Local development

```sh
cp .env.example .env          # fill in at least AUTH_SECRET, AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET
npm install
npm run dev                   # http://localhost:3000; SQLite auto-migrates at ./data/gelp.db
```

Verify the import pipeline without any network or keys:

```sh
npm run selfcheck             # builds a fixture Takeout zip, parses it, imports it twice
                              # into a temp DB, and asserts counts + cache behavior
```

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
2. **App secrets:** SSH in and create the k8s secret (or copy `deploy/k8s/20-secret.example.yaml` to `20-secret.yaml`, fill it in, and run `deploy/deploy.sh`):

   ```sh
   kubectl -n gelp create secret generic gelp-env \
     --from-literal=AUTH_SECRET=... \
     --from-literal=AUTH_GOOGLE_ID=... \
     --from-literal=AUTH_GOOGLE_SECRET=... \
     --from-literal=AUTH_URL=https://<your-host> \
     --from-literal=AUTH_TRUST_HOST=true \
     --from-literal=ALLOWED_EMAILS=you@example.com \
     --from-literal=DATABASE_PATH=/data/gelp.db \
     --from-literal=GOOGLE_MAPS_API_KEY=... \
     --from-literal=CRON_SECRET=... \
     --from-literal=GOOGLE_SERVICE_ACCOUNT_KEY_BASE64=... \
     --from-literal=DRIVE_FOLDER_ID=...
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
deploy/               Dockerfile, k8s manifests, deploy.sh, setup-server.sh, webhook config
.env.example          every environment variable, documented
```
