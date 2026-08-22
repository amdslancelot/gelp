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

## Prod rollout — done

`https://gelp.lans-h.cc` is live and serving on a valid Let's Encrypt
certificate (issued 2026-07-24), so the deploy, DNS, ingress and cert steps
this section used to list all completed. The list itself is gone rather than
ticked off: it was a runbook for work that no longer needs doing.

Not verifiable from a laptop, so left here as the things to spot-check next time
anyone is on the box:

- [ ] `gelp_rw` reaches `gelp`, is refused on `snoopy_home`, has no superuser.
- [ ] Push-to-deploy webhook is wired and firing (GitHub → `:9000/hooks/deploy`).
- [ ] `/opt/gelp/.env.prod` shredded after the first deploy, if adopting
      snoopy's Gate 3.

New, and needed before the per-user Drive sync works in prod — the app is
deployed but these two variables are not in the `gelp-env` Secret yet, so
`/settings` renders and Connect answers 503:

- [ ] Add `DRIVE_TOKEN_KEY` (`openssl rand -base64 32`) and
      `NEXT_PUBLIC_GOOGLE_PICKER_KEY` to `/opt/gelp/.env.prod`, then redeploy so
      `deploy.sh` rebuilds the Secret. Drop the now-unused
      `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64`, `DRIVE_FOLDER_ID` and `CRON_SECRET`
      from that file while there.
- [ ] Add `https://gelp.lans-h.cc/api/drive/callback` to the prod OAuth client's
      redirect URIs.
- [ ] Publish the OAuth app (Google Auth Platform → Audience → Publish app).
      Blocked until Branding carries the home page and privacy policy URLs —
      `/privacy` ships in this branch for exactly that. Publishing matters: a
      refresh token issued while the app is in Testing expires after 7 days, so
      an unpublished app means re-connecting Drive every week.

## Housekeeping

- [ ] Stop the background dev server + port-forward when done with local work
      (`npm run db:down`; the `next dev` process). They're still running from the
      migration/login testing.
- [ ] After the prod seed is verified, reclaim the rollback copy of the data:
      `podman rm gelp-pg 2>/dev/null; podman volume rm gelp-pgdata`.

## Features

- [x] **Import straight from Drive.** Shipped on `feat/per-user-drive-sync`.
      Connect once on `/settings`, then *Sync from Drive* opens the Google
      Picker, dry-runs the zip you point at, and imports it on confirmation.
      Refresh tokens are encrypted at rest with `DRIVE_TOKEN_KEY`.

      **The nightly auto-sync this started as is not possible and was removed.**
      `drive.file` is per-file by design — an app sees what its owner explicitly
      picks and nothing else, which is exactly why it needs no Google security
      review. A Takeout export generated next month is a file nobody has picked,
      so no unattended job can reach it. Verified empirically: after picking a
      folder, `files.list` returned nothing at all, not even the folder's
      contents. The alternatives were `drive.readonly` (restricted scope: CASA
      security assessment to publish, or 7-day refresh tokens while in Testing)
      or a service account each user shares a folder with (works, but adds a
      robot account and a manual sharing step). Neither was worth it against a
      button pressed after an export you took by hand anyway.

      Removed with it: the `/api/cron/import` endpoint, the CronJob manifest,
      the service-account path, and `GOOGLE_SERVICE_ACCOUNT_KEY_BASE64` /
      `DRIVE_FOLDER_ID` / `CRON_SECRET`.

## Deferred — not gelp's to own

- [ ] **Backups** — nightly `pg_dump` of the shared server → OCI Object Storage.
      A cluster-level concern for the data-plane owner (snoopy_home), not gelp.
- [ ] **transigen** provisioning lives in its own repo.
