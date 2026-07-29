import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import { inArray } from "drizzle-orm";
import { getDb, type Db } from "../lib/db";
import { lists, placeCache, places, users } from "../lib/db/schema";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

// One-off ETL: copy every row from an existing SQLite `gelp.db` into the
// Postgres pointed at by DATABASE_URL. Idempotent (primary-key conflicts are
// ignored) and driven entirely by two env vars, so the same script serves the
// dev, staging, and (later) prod cutovers.
//
//   SQLITE_PATH=./data/gelp.db \
//   DATABASE_URL=postgres://gelp_rw:<pw>@localhost:5432/gelp \
//   npm run db:migrate-data
//
// The Postgres schema must already exist; getDb() applies the drizzle
// migrations on connect, so this is handled automatically.

const SQLITE_PATH = process.env.SQLITE_PATH ?? "./data/gelp.db";

// Insert rows in primary-key-conflict-tolerant batches to stay well under
// Postgres' parameter limit and to keep re-runs idempotent.
async function insertAll(
  db: Db,
  table: PgTable,
  rows: Record<string, unknown>[],
): Promise<void> {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    if (chunk.length === 0) continue;
    // values() is generically typed per-table; this one-off inserts already
    // transformed rows, so cast past the per-column generic.
    await (db.insert(table) as ReturnType<Db["insert"]>)
      .values(chunk)
      .onConflictDoNothing();
  }
}

// Count how many of `keys` are actually present in the target table, matched by
// primary key. This is a real per-row presence check: unlike a bare row count
// it can't be masked by unrelated pre-existing rows, and it catches a source
// row that onConflictDoNothing skipped without importing.
async function presentByKey(
  db: Db,
  table: PgTable,
  pk: PgColumn,
  keys: string[],
): Promise<number> {
  let found = 0;
  const BATCH = 500;
  for (let i = 0; i < keys.length; i += BATCH) {
    const chunk = keys.slice(i, i + BATCH);
    if (chunk.length === 0) continue;
    const rows = await db
      .select({ k: pk })
      .from(table)
      .where(inArray(pk, chunk));
    found += rows.length;
  }
  return found;
}

async function main() {
  if (!existsSync(SQLITE_PATH)) {
    console.log(`No SQLite database at ${SQLITE_PATH} — nothing to migrate.`);
    return;
  }

  console.log(`Reading SQLite from ${resolve(SQLITE_PATH)}`);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });

  // Read every table with plain prepared statements — the drizzle schema is now
  // Postgres-shaped, so we cannot route the SQLite read through it.
  const srcUsers = sqlite
    .prepare("SELECT id, email, name, image, created_at FROM users")
    .all() as Record<string, unknown>[];
  const srcCache = sqlite
    .prepare(
      "SELECT key, place_id, name, address, lat, lng, category, types, fetched_at FROM place_cache",
    )
    .all() as Record<string, unknown>[];
  const srcLists = sqlite
    .prepare(
      "SELECT id, user_id, name, source, imported_at, hidden FROM lists",
    )
    .all() as Record<string, unknown>[];
  const srcPlaces = sqlite
    .prepare(
      "SELECT id, list_id, user_id, title, note, maps_url, cache_key FROM places",
    )
    .all() as Record<string, unknown>[];
  sqlite.close();

  // Transform snake_case rows into drizzle's camelCase shape. The only column
  // that changes type is `lists.hidden` (SQLite 0/1 integer -> boolean).
  const usersRows = srcUsers.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    image: r.image,
    createdAt: r.created_at,
  }));
  const cacheRows = srcCache.map((r) => ({
    key: r.key,
    placeId: r.place_id,
    name: r.name,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    category: r.category,
    types: r.types,
    // The SQLite schema predates `status`. Mirror migration 0002's backfill: a
    // row that never resolved is treated as a failed lookup, so it is retried
    // once rather than kept as a permanent blank.
    status:
      r.lat === null && r.place_id === null
        ? ("unavailable" as const)
        : ("ok" as const),
    fetchedAt: r.fetched_at,
  }));
  const listsRows = srcLists.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    source: r.source,
    importedAt: r.imported_at,
    hidden: Boolean(r.hidden),
  }));
  const placesRows = srcPlaces.map((r) => ({
    id: r.id,
    listId: r.list_id,
    userId: r.user_id,
    title: r.title,
    note: r.note,
    mapsUrl: r.maps_url,
    cacheKey: r.cache_key,
  }));

  const db = await getDb();

  // Load in foreign-key-safe order: users <- lists, place_cache <- places,
  // lists <- places.
  console.log("Loading into Postgres…");
  await insertAll(db, users, usersRows);
  await insertAll(db, placeCache, cacheRows);
  await insertAll(db, lists, listsRows);
  await insertAll(db, places, placesRows);

  // Verify: every source row must be present in the target, matched by primary
  // key (not merely by row count).
  const checks: {
    name: string;
    table: PgTable;
    pk: PgColumn;
    keys: string[];
  }[] = [
    { name: "users", table: users, pk: users.id, keys: usersRows.map((r) => r.id as string) },
    { name: "place_cache", table: placeCache, pk: placeCache.key, keys: cacheRows.map((r) => r.key as string) },
    { name: "lists", table: lists, pk: lists.id, keys: listsRows.map((r) => r.id as string) },
    { name: "places", table: places, pk: places.id, keys: placesRows.map((r) => r.id as string) },
  ];

  console.log("\nVerification (source rows present in target, by primary key):");
  let ok = true;
  for (const { name, table, pk, keys } of checks) {
    const found = await presentByKey(db, table, pk, keys);
    const mark = found === keys.length ? "OK " : "BAD";
    if (found !== keys.length) ok = false;
    console.log(`  ${mark} ${name}: ${found}/${keys.length} present`);
  }

  if (!ok) {
    console.log("\nDATA MIGRATION FAILED: target is missing rows.");
    process.exit(1);
  }
  console.log("\nDATA MIGRATION OK");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
