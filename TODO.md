# Gelp — leftover items

Dev and staging are shipped and verified: Postgres migration, internal-UUID
identity, shared `data`-namespace Postgres (owned by snoopy_home), env-file
secrets, and an open public allowlist. Merged to `main` and pushed
(`72dce07`); one follow-up commit (`163bd3d`, open-allowlist templates) is
local only. What's left:

## Quick items

- [ ] Push the pending commit `163bd3d` so `origin/main` is current (cosmetic —
      prod reads `ALLOWED_EMAILS` from `.env.prod`, not the template — but tidy
      before the prod deploy, which pulls `origin/main`).
- [ ] Docs: add snoopy's Gate 3 **shred** step to the prod runbook — after the
      first `deploy.sh`, `shred -u .env.prod` so no password persists on disk
      (deploy.sh's "secret exists → leave as-is" branch already supports this);
      document the rotate flow (drop `.env.prod` back → deploy → shred again).
- [ ] *(Optional, only if data grows)* add indexes on the FK columns
      `lists.user_id`, `places.user_id`, `places.list_id` — irrelevant at 70 lists.

## Prod rollout (needs SSH to the OCI box)

Target: fresh gelp deploy onto the existing prod k3s (where snoopy + the shared
Postgres already run), seeded with the current data.

- [ ] **OCI security list:** allow inbound TCP **80, 443, 9000** (snoopy likely
      opened 80/443; 9000 is gelp's webhook — check it doesn't collide with a
      snoopy webhook listener; if it does, share one listener or pick another port).
- [ ] **Confirm the shared data plane** on the box: `kubectl get svc postgres -n data`
      exists; note whether Postgres is a Deployment or StatefulSet (sets
      `POSTGRES_WORKLOAD` for the next step).
- [ ] **Provision gelp on prod Postgres:**
      `GELP_DB_PASSWORD="$(openssl rand -hex 24)" bash /opt/gelp/scripts/provision-db.sh`
      (keep the password). Verifies `gelp_rw` isolation automatically.
- [ ] **Create `/opt/gelp/.env.prod`** from `.env.prod.example` (gitignored):
      new OAuth client ID/secret, `DATABASE_URL` with the `gelp_rw` password
      from the previous step + `@postgres.data.svc:5432/gelp`,
      `AUTH_URL=https://gelp.lans-h.cc`, `ALLOWED_EMAILS=` (empty, public).
- [ ] **Bootstrap + deploy:** run `setup-server.sh` with `GELP_HOST=gelp.lans-h.cc`,
      `LETSENCRYPT_EMAIL`, a fresh `WEBHOOK_SECRET`, `REPO_URL` — it skips the
      k3s install since k3s already exists — then it runs `deploy.sh` (builds the
      image, creates the `gelp-env` Secret from `.env.prod`, applies the prod
      overlay, cert-manager issues the Let's Encrypt cert).
- [ ] **Seed the data:** regenerate the data-only dump from the preserved
      `gelp-pgdata` podman volume (throwaway `postgres:17` container →
      `pg_dump --data-only --disable-triggers -t users -t lists -t places -t place_cache`),
      **re-point `user_id` to the internal UUID `d79ce418-4686-4c6e-b077-654bcbc7e900`**,
      and load into prod's `gelp` DB. (The UUID is stable; prod login stamps
      `google_sub` on first sign-in, same as staging.)
- [ ] **Verify prod:** `gelp_rw` reaches `gelp`, is refused on `snoopy_home`,
      has no superuser; `https://gelp.lans-h.cc` serves with a valid cert; sign
      in shows the 70 lists.
- [ ] **Wire push-to-deploy:** GitHub webhook → `http://92.5.135.46:9000/hooks/deploy`,
      secret = `WEBHOOK_SECRET`, push events only.
- [ ] *(If adopting snoopy's Gate 3)* `shred -u /opt/gelp/.env.prod` after the
      first deploy.

## Housekeeping

- [ ] Stop the background dev server + port-forward when done with local work
      (`npm run db:down`; the `next dev` process). They're still running from the
      migration/login testing.
- [ ] After the prod seed is verified, reclaim the rollback copy of the data:
      `podman rm gelp-pg 2>/dev/null; podman volume rm gelp-pgdata`.

## Features

- [x] **Per-user nightly Drive Takeout auto-sync.** Shipped on
      `feat/per-user-drive-sync`. Each user connects their own Drive on
      `/settings` (incremental OAuth, `drive.file` scope) and picks the Takeout
      folder through the Google Picker; the nightly CronJob loops over everyone
      who has, with each user isolated so one revoked grant cannot stall the
      rest. Refresh tokens are encrypted at rest with `DRIVE_TOKEN_KEY`.
      Remaining:
      - [ ] End-to-end test against a real Drive folder (needs
            `NEXT_PUBLIC_GOOGLE_PICKER_KEY` + the second redirect URI in the
            Google console).
      - [ ] Once it has run in prod for a while, delete the single-tenant
            fallback in `app/api/cron/import/route.ts` (`legacyImport`) and with
            it `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`, `DRIVE_FOLDER_ID`,
            `isDriveConfigured`, and `fetchLatestTakeoutZip`.

## Deferred — not gelp's to own

- [ ] **Backups** — nightly `pg_dump` of the shared server → OCI Object Storage.
      A cluster-level concern for the data-plane owner (snoopy_home), not gelp.
- [ ] **transigen** provisioning lives in its own repo.
