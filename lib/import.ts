import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "./db";
import { lists, placeCache, places, type PlaceCache } from "./db/schema";
import type { ParsedPlace, ParsedTakeout } from "./takeout";
import type { PlacesClient } from "./places";

// Counts returned from an import run, useful for the upload UI and logs.
export interface ImportResult {
  lists: number;
  places: number;
  cacheHits: number;
  apiCalls: number;
  // Lists deleted because the export no longer contains them.
  listsRemoved: number;
}

// A live progress tick emitted as places are processed, so the upload UI can
// render a progress bar. `processed`/`total` count places (the slow, API-bound
// unit of work); `currentList` names the list being worked on right now.
export interface ImportProgress {
  processed: number;
  total: number;
  listsDone: number;
  totalLists: number;
  currentList: string;
}

// Compute the enrichment cache key for a place. Using the Maps URL when present
// makes the key stable across re-imports; otherwise fall back to the title and
// address. This is what caps each real place at one Places API call ever.
export function cacheKeyFor(place: ParsedPlace): string {
  if (place.mapsUrl && place.mapsUrl.trim() !== "") {
    return place.mapsUrl.trim();
  }
  return place.title.toLowerCase().trim() + "|" + (place.address ?? "");
}

// How long an unresolved cache row stays authoritative. A resolved row never
// expires — one call per real place, forever, is the whole point of the cache.
// The two failure kinds differ because they mean different things: the API
// saying "no such place" is an answer worth keeping, while a failed lookup is
// only ever a statement about the last few hours.
export const NOT_FOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Rows per statement, for both the cache lookup and the place insert. Postgres
// caps a statement at 65535 bind parameters; at one parameter per looked-up key
// and seven per inserted place, this stays comfortably clear of that ceiling
// however large a list is.
const BATCH_SIZE = 1000;

// Whether a cache row can still be used as-is, or has aged out and should be
// looked up again.
export function isCacheFresh(
  row: Pick<PlaceCache, "status" | "fetchedAt">,
  now: number,
): boolean {
  if (row.status === "ok") return true;
  const ttl =
    row.status === "not_found" ? NOT_FOUND_TTL_MS : UNAVAILABLE_TTL_MS;
  return now - row.fetchedAt < ttl;
}

// Write one enrichment result, replacing an expired row for the same key, and
// return whatever the row now is.
//
// The guard keeps a resolved row resolved: if a concurrent import already
// answered this key, a lookup that came back empty here must not overwrite it
// with a blank. A resolved answer always wins over an unresolved one — in which
// case the update writes nothing and there is no returned row.
async function writeCache(
  db: Db,
  row: PlaceCache,
): Promise<PlaceCache | undefined> {
  const { key: _key, ...updatable } = row;
  const [stored] = await db
    .insert(placeCache)
    .values(row)
    .onConflictDoUpdate({
      target: placeCache.key,
      set: updatable,
      setWhere: sql`${placeCache.status} <> 'ok' or excluded.status = 'ok'`,
    })
    .returning();
  return stored;
}

// Load the cache rows for a whole list in one round trip per batch.
//
// The per-place alternative is a query per place: an import that is entirely
// cache hits — the common case, and the one the cache exists to make cheap —
// would still pay a round trip for every place it did not have to look up,
// which dominates everything else the import does.
async function loadCache(
  db: Db,
  keys: string[],
): Promise<Map<string, PlaceCache>> {
  const unique = [...new Set(keys)];
  const found = new Map<string, PlaceCache>();
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const rows = await db
      .select()
      .from(placeCache)
      .where(inArray(placeCache.key, unique.slice(i, i + BATCH_SIZE)));
    for (const row of rows) found.set(row.key, row);
  }
  return found;
}

// Import a parsed Takeout into the database for one user. Lists are upserted by
// (user_id, name) and their places replaced on re-import — atomically, one
// transaction per list, so a list is never observed emptied. Lists the export
// no longer contains are deleted, so the import mirrors the account rather than
// only ever growing it. Enrichment consults
// the cache first, then parsed coordinates, then the Places client, caching
// every outcome (including misses) so a miss is never re-billed — but an
// unresolved row expires, so a failed lookup is retried later rather than
// blanking the place out forever.
export async function runImport(
  db: Db,
  userId: string,
  parsed: ParsedTakeout,
  client: PlacesClient,
  source: "upload" | "drive",
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const result: ImportResult = {
    lists: 0,
    places: 0,
    cacheHits: 0,
    apiCalls: 0,
    listsRemoved: 0,
  };

  // Precomputed denominators so the UI can show a stable "x / total" bar.
  const totalPlaces = parsed.lists.reduce((n, l) => n + l.places.length, 0);
  const totalLists = parsed.lists.length;

  for (const parsedList of parsed.lists) {
    result.lists += 1;

    // Phase 1 — enrichment. Deliberately outside the transaction below: it is
    // the slow, network-bound half, and holding a transaction open across
    // Places API calls would pin a connection and keep the list's rows locked
    // for the length of an HTTP round trip per place. Nothing here touches
    // this list's rows — the place cache is global, idempotent, and safe to
    // fill in whether or not the import that fills it goes on to succeed.
    const enriched: Array<typeof places.$inferInsert> = [];
    const keys = parsedList.places.map(cacheKeyFor);

    // Everything this list already has, in one round trip per batch. Rows
    // written below are folded back in, so a place repeated within a list is a
    // hit on its second appearance rather than a second API call.
    const cache = await loadCache(db, keys);

    for (const [index, parsedPlace] of parsedList.places.entries()) {
      result.places += 1;
      const key = keys[index];
      const cached = cache.get(key);

      if (cached && isCacheFresh(cached, Date.now())) {
        // Resolved before, or an unresolved answer that is still within its
        // lifetime: zero API calls either way.
        result.cacheHits += 1;
      } else if (
        parsedPlace.lat !== undefined &&
        parsedPlace.lng !== undefined
      ) {
        // Coordinates came straight from Saved Places.json: zero API calls.
        const row: PlaceCache = {
          key,
          placeId: null,
          name: parsedPlace.title,
          address: parsedPlace.address ?? null,
          lat: parsedPlace.lat,
          lng: parsedPlace.lng,
          category: null,
          types: null,
          status: "ok",
          fetchedAt: Date.now(),
        };
        cache.set(key, (await writeCache(db, row)) ?? row);
      } else {
        // Resolve via the Places client and cache the outcome — misses
        // included, so a genuine miss is not re-billed on every import. The
        // row records *why* it is unresolved, which is what decides whether a
        // later import retries it (see `isCacheFresh`).
        result.apiCalls += 1;
        const query =
          parsedPlace.title +
          (parsedPlace.address ? " " + parsedPlace.address : "");
        const lookup = await client.searchText(query);
        const found = lookup.status === "ok" ? lookup.place : null;
        const row: PlaceCache = {
          key,
          placeId: found?.placeId ?? null,
          name: found?.name ?? parsedPlace.title,
          address: found?.address ?? parsedPlace.address ?? null,
          lat: found?.lat ?? null,
          lng: found?.lng ?? null,
          category: found?.category ?? null,
          types: found ? JSON.stringify(found.types) : null,
          status: lookup.status,
          fetchedAt: Date.now(),
        };
        cache.set(key, (await writeCache(db, row)) ?? row);
      }

      enriched.push({
        id: randomUUID(),
        // Filled in inside the transaction, once the list row is known.
        listId: "",
        userId,
        title: parsedPlace.title,
        note: parsedPlace.note ?? null,
        mapsUrl: parsedPlace.mapsUrl ?? null,
        cacheKey: key,
      });

      onProgress?.({
        processed: result.places,
        total: totalPlaces,
        listsDone: result.lists - 1,
        totalLists,
        currentList: parsedList.name,
      });
    }

    // Phase 2 — swap the list's contents. The delete and the re-insert are one
    // transaction, so an import that dies partway (a killed pod, a dropped
    // connection — the nightly sync runs unattended) can no longer leave a list
    // emptied or half-filled. It rolls back to exactly what was there before.
    await db.transaction(async (tx) => {
      // Upsert the list by (user_id, name). One statement, resolved by the
      // unique constraint, so a concurrent import lands on the same row instead
      // of creating a second list with the same name. `hidden` is deliberately
      // left alone — it is the user's setting, not the export's.
      const [row] = await tx
        .insert(lists)
        .values({
          id: randomUUID(),
          userId,
          name: parsedList.name,
          source,
          importedAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: [lists.userId, lists.name],
          set: { source, importedAt: Date.now() },
        })
        .returning({ id: lists.id });

      // Replace the list's places; the delete is a no-op for a new list.
      await tx.delete(places).where(eq(places.listId, row.id));
      for (let i = 0; i < enriched.length; i += BATCH_SIZE) {
        await tx.insert(places).values(
          enriched
            .slice(i, i + BATCH_SIZE)
            .map((place) => ({ ...place, listId: row.id })),
        );
      }
    });
  }

  // A Takeout "Saved" export is a complete snapshot, so a list the account
  // still has cannot be missing from it: anything left over here was deleted in
  // Google Maps and is deleted here too. Its places go with it, by cascade.
  //
  // The empty-export guard matters because this is the one destructive step
  // that is not scoped to a named list. An export that parsed to nothing is
  // overwhelmingly more likely to be a broken or half-downloaded zip than an
  // account that genuinely deleted every list, and treating it as the latter
  // would wipe the user's data on a bad download.
  const importedNames = parsed.lists.map((l) => l.name);
  if (importedNames.length > 0) {
    const removed = await db
      .delete(lists)
      .where(
        and(eq(lists.userId, userId), notInArray(lists.name, importedNames)),
      )
      .returning({ id: lists.id });
    result.listsRemoved = removed.length;
  }

  return result;
}
