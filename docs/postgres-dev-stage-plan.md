# Gelp: Postgres migration + dev/stage containerization (2026 standard)

## Context

`gelp` (Next.js 15 App Router, Auth.js v5) currently uses **SQLite via `better-sqlite3`** and deploys to a single-node OCI k3s cluster. This plan does three things, per the latest direction:

1. **Migrate the database SQLite → PostgreSQL.** SQLite-on-a-PVC is the weakest part of the current design (single-writer, no real concurrency, backup = copy a file). Postgres is the 2026 default for a server app and unblocks multi-replica later.
2. **Define two environments only — dev and stage** (prod is explicitly deferred). Dev stays `npm run dev`. Stage = build the image locally and deploy to a **local upstream-Kubernetes** cluster (**minikube**) with an in-cluster Postgres.
3. **Fully podman — no Docker anywhere.** Builds use `podman build`; dev Postgres uses `podman compose`; the local cluster is a minikube VM (native macOS driver, so no container runtime is even required for the cluster itself). This matches the prod tooling — `deploy/deploy.sh` already auto-detects podman.

Deliberate divergence: **stage runs upstream Kubernetes (minikube); prod runs k3s.** Manifests stay portable via Kustomize. **Ingress is Traefik in both** — k3s bundles it, and on minikube it's a small Helm install. ingress-nginx is deliberately avoided: the Kubernetes project announced its retirement in Nov 2025 (best-effort maintenance ended March 2026), so it is no longer a sound 2026 choice. Only `storageClassName` differs per overlay.

The non-obvious cost driver: **better-sqlite3 is synchronous** (`.all()/.run()/.get()`), so `loadLists` and the import pipeline are synchronous today. Every Node Postgres driver is **async**, so this migration forces a sync→async conversion across the data layer. The blast radius is bounded — measured below.

## Environments

Prod deferred. Both active environments share the same image and the same Postgres engine (parity).

| | Dev | Stage |
|---|---|---|
| App | `npm run dev` (`next dev`, HMR) | `podman`-built image, deployed to local k8s |
| Cluster | none | **minikube** (upstream Kubernetes, native macOS VM driver) |
| Postgres | `postgres:17` via `podman compose` on `localhost:5432` | In-cluster Postgres (StatefulSet + PVC + Service) in ns `gelp-staging` |
| Config | local `.env` → `DATABASE_URL` | Secret `gelp-env` (staging values) via `envFrom` |
| Ingress | — | **Traefik via Helm** (parity with k3s prod) → `staging.localhost`, or `kubectl port-forward` |
| Access | `localhost:3000` | `staging.localhost` (via `minikube tunnel`/hosts) or port-forward |

Dev deliberately stays non-containerized (fast HMR); it just points at a Postgres container. Stage is the containerized parity environment. **Prod (deferred) will be k3s** — same manifests, different overlay.

---

## Part 1 — SQLite → PostgreSQL migration

### 1a. Driver + deps (`package.json`)
- Add `pg` + `@types/pg`. Use drizzle's `drizzle-orm/node-postgres` (Pool-based; the mainstream 2026 choice). `postgres` (postgres.js) is a fine alternative but `pg` is the most standard.
- **Keep `better-sqlite3` as a devDependency for now** — the one-off data-migration ETL (Part 5) still needs to read the old SQLite file. Remove it (and any `@types/better-sqlite3`) only after the data migration has run and been verified. The app runtime (`lib/db/index.ts`) stops importing it in step 1c regardless.

### 1b. Schema (`lib/db/schema.ts`) — `sqliteTable` → `pgTable`
Import from `drizzle-orm/pg-core`. Per-column conversions (preserving the existing numeric-millis contract so app code and `selfcheck` keep working):
- `text(...).primaryKey()` / `text(...)` → unchanged (pg has `text`).
- Timestamps stored as epoch-millis integers (`created_at`, `imported_at`, `fetched_at`, currently `integer` + `default sql\`(unixepoch() * 1000)\``) → **`bigint({ mode: "number" })`** with default `sql\`(extract(epoch from now()) * 1000)::bigint\``. Keeps them JS numbers (millis fit in 2^53), so `createdAt: Date.now()` in code is unchanged.
- `hidden: integer("hidden", { mode: "boolean" })` → **`boolean("hidden").notNull().default(false)`**. The query `eq(lists.hidden, false)` still works.
- `real("lat"/"lng")` → **`doublePrecision(...)`** (matches SQLite's 8-byte float).
- `text("source", { enum: [...] })` → keep as `text(..., { enum: [...] })` in pg-core (avoids introducing a DB-level enum type; lowest churn).
- `.references(..., { onDelete: "cascade" })` → identical API in pg-core.

### 1c. Connection (`lib/db/index.ts`) — rewrite
- Replace `better-sqlite3` + file/mkdir logic with a `pg` **Pool** + `drizzle-orm/node-postgres`, keyed off **`DATABASE_URL`** (not `DATABASE_PATH`).
- Migrate on first call via `drizzle-orm/node-postgres/migrator` (runtime migrate-on-start stays — fine for single replica).
- Keep the cached-singleton pattern. Drop the WAL/foreign_keys pragmas (SQLite-only).

### 1d. Sync → async conversion (the ripple) — bounded to these sites
Measured call sites of synchronous drizzle methods and `getDb()`:
- **`lib/queries.ts`** — `loadLists` becomes `async`; drop `.all()`, `await` the `db.select()` calls. Its **only caller** is `app/page.tsx:14` (`const lists = loadLists(...)`) → make it `const lists = await loadLists(...)` (already an async server component).
- **`lib/import.ts`** — the bulk: `.get()/.run()` at lines ~52–142. Convert to `await`; wrap the per-list delete+insert in a real `db.transaction(async (tx) => …)` (a strict improvement over SQLite's per-statement autocommit). Preserve the place-cache dedupe semantics exactly.
- **`app/api/cron/import/route.ts`** — `.get()/.run()/.all()` at lines 46–56 → `await`.
- **`app/api/import/upload/route.ts`** — `getDb()` at line 40; ensure the `runImport` call is awaited (it already returns a promise).
- **`scripts/selfcheck.ts`** — swap the better-sqlite3 test harness (lines 5–7, 147–150) for `pg` + `drizzle-orm/node-postgres`; convert `.run()/.all()` to `await`. Preserve the current throwaway-DB-per-run semantics: connect to the dev compose server, `CREATE DATABASE gelp_selfcheck_<random>` via an admin connection, run migrations + assertions there, `DROP DATABASE` at the end — so repeated runs stay hermetic and never touch the dev `gelp` database.

### 1e. Migrations regen (`drizzle/`, `drizzle.config.ts`)
- `drizzle.config.ts`: `dialect: "postgresql"`, `dbCredentials: { url: process.env.DATABASE_URL }`.
- The existing SQLite migrations can't apply to Postgres. **Delete `drizzle/0000_*.sql`, `drizzle/0001_*.sql`, and `drizzle/meta/`**, then `npm run db:generate` to produce a fresh Postgres baseline. (Note: git status already shows uncommitted `schema.ts`/`queries.ts`/journal changes — reconcile with those before regenerating.)

### 1f. `next.config.ts`
- Swap `serverExternalPackages: ["better-sqlite3"]` → `serverExternalPackages: ["pg"]`. `pg` is pure JS but carries a dynamic optional `pg-native` require that Next's server bundler can trip on — keeping it external is the safe standard. Keep `output: "standalone"` (standalone tracing includes external packages in `node_modules`).

### 1g. Data migration
Carrying existing SQLite rows into Postgres is a first-class deliverable — see **Part 5**.

---

## Part 2 — Dev environment (podman)

- Add **`compose.yaml`** at repo root: one `postgres:17` service, named volume, `POSTGRES_USER/PASSWORD/DB=gelp`, port `5432:5432`, `healthcheck` on `pg_isready`. Runs under `podman compose` (the file is engine-agnostic).
- `.env` / `.env.example`: replace `DATABASE_PATH` with `DATABASE_URL=postgres://gelp:gelp@localhost:5432/gelp`.
- Dev loop: `podman compose up -d db` → `npm run dev`. Runtime migrations create the schema on first hit.
- Optional convenience scripts in `package.json`: `db:up` (`podman compose up -d db`), `db:down`.

## Part 3 — Stage: podman build → minikube (upstream k8s)

### 3a. Local cluster
- **minikube** with a native macOS VM driver: `minikube start --driver=vfkit` (qemu fallback). Real upstream Kubernetes, no host container runtime required.
- Ingress: **Traefik via Helm** (`helm install traefik traefik/traefik`) — parity with k3s's bundled Traefik in prod, and avoids the retired ingress-nginx (minikube's `ingress` addon). Reach the app via `minikube tunnel` + a `staging.localhost` hosts entry, or skip ingress locally and `kubectl port-forward`.

### 3b. In-cluster Postgres
- Add a **Postgres StatefulSet + headless Service + PVC** (`postgres:17`) in ns `gelp-staging`, credentials from a `gelp-postgres` Secret. Service DNS `gelp-postgres.gelp-staging.svc` → the app's `DATABASE_URL`.
  - **Superseded (twice):** the Postgres was first moved out of the app namespace into a shared `data` namespace owned by this repo; that package was then retired in favor of the **cluster-wide shared Postgres owned by the snoopy_home repo** (`snoopy_home/docs/PLAN-postgres-role-isolation.md` — one server per cluster, one database + `_rw` role per app across snoopy/transigen/gelp). gelp connects at `postgres.data.svc:5432/gelp` as `gelp_rw`; dev has no database of its own and port-forwards to the staging server (`npm run db:up`). The podman dev Postgres (`compose.yaml`, `gelp-pg`, `db:up`/`db:down` podman scripts) is likewise retired.
- App and Postgres are **separate workloads** (Deployment vs StatefulSet in their own pods), never two containers in one pod — their lifecycles must be independent so app rollouts/rollbacks never restart the database, and each gets its own resources and storage.
- (2026 production-grade alternative, noted for later: the **CloudNativePG** operator. Overkill for local stage — StatefulSet is the pragmatic default.)

### 3c. App manifests — Kustomize overlay (portable across k8s and k3s)
Environments differing only by namespace/host/image/secret is the canonical **Kustomize** case (built into `kubectl -k`, no extra tooling):
- `deploy/k8s/base/` — deployment, service, ingress, cronjob + `kustomization.yaml`. Deployment reads `DATABASE_URL` from `gelp-env`; drop the SQLite PVC mount at `/data` from the *app* (only Postgres needs a PVC now).
- `deploy/k8s/overlays/staging/` — `namespace: gelp-staging`, ingress host `staging.localhost`, the Postgres StatefulSet, `images:` → the locally built tag.
- `deploy/k8s/overlays/prod/` — **deferred stub** documenting the k3s deltas (cert-manager issuer, real host, k3s `local-path` storageClass). Not built now, but the base is authored to make it a thin overlay later.
- `ingressClassName: traefik` lives in the **base** — identical in stage and prod (see ingress rationale above).
- Migrate the existing flat numbered YAMLs into the base; retire the app `/data` PVC (`30-pvc.yaml`) in favor of the Postgres PVC.
- **CronJob URL fix:** the current `70-cronjob.yaml` curls `http://gelp.gelp.svc.cluster.local/...` — a hardcoded namespace that Kustomize's namespace transform will NOT rewrite (it's inside an arg, not a metadata field). The base must use the namespace-relative `http://gelp/api/cron/import` so the same manifest works in `gelp-staging` and later `gelp`.
- **OAuth for stage:** Auth.js sign-in from the staging origin requires (a) `AUTH_URL=http://staging.localhost` (or the port-forward origin) in the staging `gelp-env` secret, and (b) that redirect URI added to the Google OAuth client in GCP console. One-time manual step — document in `deploy/README.md`.

### 3d. Build + load + deploy (local, no registry, no docker)
- `podman build -f deploy/Dockerfile -t gelp:dev .`
- `podman save gelp:dev | minikube image load -` (no registry; mirrors the current prod "import into containerd" model).
- `kubectl apply -k deploy/k8s/overlays/staging`
- A small `deploy/stage.sh` wrapping build → load → apply → `kubectl rollout status`.

## Part 4 — Dockerfile cleanup (from the DB change)

- Drop the `python3 make g++` build-toolchain (only needed to compile `better-sqlite3`); `pg` needs none → smaller, faster builder. Builds identically under `podman build` (OCI image works on both minikube/k8s and prod k3s).
- Remove the `/data` volume ownership setup (SQLite artifact).
- Keep standalone output, non-root user, `CMD ["node","server.js"]`. **Optional polish:** bump `node:20-alpine` → a supported LTS (Node 22/24) and pin by digest — nice-to-have, not required for this scope. *Verify current LTS before changing.*

---

## Part 5 — SQLite → Postgres data migration (one-off ETL)

A one-off script that copies existing rows from a SQLite `gelp.db` into a target Postgres. Reusable for any target — the dev compose DB, staging, or (later) prod — since it's driven purely by two env vars.

### 5a. The script — `scripts/migrate-sqlite-to-pg.ts`
Run with `tsx` (already a dep). Invocation:
```
SQLITE_PATH=./data/gelp.db DATABASE_URL=postgres://gelp:gelp@localhost:5432/gelp \
  npm run db:migrate-data     # -> tsx scripts/migrate-sqlite-to-pg.ts
```
Steps:
1. **Precondition — target schema exists.** The Postgres schema must already be applied (the app applies drizzle migrations on first `getDb()`; or run migrations directly). The script connects and asserts the four tables exist.
2. **Read source.** Open `SQLITE_PATH` **read-only** via `better-sqlite3` (the temporary devDependency from 1a), raw `SELECT *` per table. Do *not* route the read through drizzle — the drizzle schema is now `pgTable`, so read the SQLite side with plain prepared statements.
3. **Transform** (only two columns actually change shape):
   - `lists.hidden`: SQLite `0/1` integer → Postgres `boolean` (`Boolean(row.hidden)`).
   - Everything else passes through: epoch-millis timestamps stay numbers (→ `bigint` mode `number`), `lat/lng` stay numbers (→ `doublePrecision`), `types` stays a JSON string, all nullable columns pass `NULL` through.
4. **Load in FK-safe order** via drizzle (new pg schema), each wrapped in one `db.transaction`:
   `users → place_cache → lists → places`
   (`lists.user_id`→users; `places.list_id`→lists, `places.user_id`→users, `places.cache_key`→place_cache). Use `.onConflictDoNothing()` on the primary keys so re-runs are idempotent. Batch inserts (e.g. chunks of ~500 rows) to stay under Postgres parameter limits.
5. **Verify.** After load, compare `COUNT(*)` per table between source and target; on any mismatch, print the offending table and exit non-zero. Print a summary table (source → target counts).

### 5b. Cutover sequence (when moving real data)
1. Stand up the target Postgres; apply the schema (start the app once, or run migrations).
2. For a live source (prod PVC), quiesce writes first (scale the app to 0 / maintenance) and snapshot-copy `gelp.db` so the ETL reads a consistent file.
3. Run the ETL against the target `DATABASE_URL`; confirm the verify step passes.
4. Point the app's `DATABASE_URL` at Postgres and redeploy.
5. Keep the SQLite file as a rollback artifact until the Postgres app is confirmed healthy. Only then remove `better-sqlite3` (1a) and retire the ETL if desired.

### 5c. Edge cases to honor
- **`hidden` legacy values** — map any truthy integer to `true`, `0`/`NULL` to `false` (column is `notNull default false`).
- **Orphan/`NULL` `cache_key`** — nullable and self-consistent since `place_cache` loads first; pass through.
- **Empty source** (fresh install, no `gelp.db`) — the script should no-op cleanly, not error.

---

## Files to touch
- **DB core:** `lib/db/schema.ts`, `lib/db/index.ts`, `drizzle.config.ts`, `drizzle/*` (regen), `next.config.ts`, `package.json`
- **Async ripple:** `lib/queries.ts`, `lib/import.ts`, `app/page.tsx`, `app/api/cron/import/route.ts`, `app/api/import/upload/route.ts`, `scripts/selfcheck.ts`
- **Data migration:** `scripts/migrate-sqlite-to-pg.ts` (new), `package.json` `db:migrate-data` script; `better-sqlite3` retained as devDependency until the ETL has run
- **Dev:** `compose.yaml`, `.env.example` (+ local `.env`)
- **Stage:** `deploy/k8s/base/` + `deploy/k8s/overlays/staging/` (+ deferred `overlays/prod/` stub), refactored from flat `deploy/k8s/*.yaml`; Postgres manifests, `deploy/stage.sh`, `deploy/Dockerfile`

## Verification (end-to-end)
1. **Typecheck/build:** `npm run build` succeeds with no `better-sqlite3` references; standalone output produced.
2. **Selfcheck on Postgres:** `podman compose up -d db` then `npm run selfcheck` → all assertions PASS against Postgres (proves the async import pipeline + cache semantics survived).
3. **Dev run:** `npm run dev`, sign in, import a Takeout zip, confirm lists/places render and map pins work; verify rows land in Postgres (`psql`).
4. **Stage build:** `podman build` succeeds without the native toolchain; `podman save … | minikube image load -` loads the image.
5. **Stage deploy:** `kubectl apply -k deploy/k8s/overlays/staging`; `kubectl rollout status deployment/gelp -n gelp-staging` succeeds; Postgres pod healthy; app reaches DB (migrations applied on start).
6. **Stage smoke:** hit `staging.localhost/api/health` (via `minikube tunnel` or port-forward) → healthy; do one import through the deployed app end-to-end.
7. **Data migration:** seed a SQLite `gelp.db` (e.g. run the old app or `selfcheck` on the SQLite branch), run `db:migrate-data` into the dev Postgres, confirm the per-table count verification passes and the migrated lists/places render in the app. Re-run the ETL and confirm idempotency (no duplicates, counts unchanged).

## Deferred (explicitly out of scope now)
- **Prod** (OCI k3s) rollout, CI + registry (GHCR), digest promotion, rollback tooling. (The data-migration ETL from Part 5 is built now and reused for the eventual prod cutover — see 5b.)
- CloudNativePG operator, supply-chain (SBOM/cosign/SLSA/Trivy), pod securityContext hardening — revisit when prod comes back into scope.
