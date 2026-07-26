import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "./db";
import { lists, placeCache, places } from "./db/schema";
import type { ParsedPlace, ParsedTakeout } from "./takeout";
import type { PlacesClient } from "./places";

// Counts returned from an import run, useful for the upload UI and logs.
export interface ImportResult {
  lists: number;
  places: number;
  cacheHits: number;
  apiCalls: number;
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

// Import a parsed Takeout into the database for one user. Lists are upserted by
// (user_id, name) and their places replaced on re-import. Enrichment consults
// the cache first, then parsed coordinates, then the Places client, caching
// every outcome (including misses) so failures never re-bill.
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
  };

  // Precomputed denominators so the UI can show a stable "x / total" bar.
  const totalPlaces = parsed.lists.reduce((n, l) => n + l.places.length, 0);
  const totalLists = parsed.lists.length;

  for (const parsedList of parsed.lists) {
    result.lists += 1;

    // Upsert the list by (user_id, name).
    const existingRows = await db
      .select()
      .from(lists)
      .where(and(eq(lists.userId, userId), eq(lists.name, parsedList.name)))
      .limit(1);
    const existing = existingRows[0];

    let listId: string;
    if (existing) {
      listId = existing.id;
      // Replace the list's places on re-import.
      await db.delete(places).where(eq(places.listId, listId));
      await db
        .update(lists)
        .set({ source, importedAt: Date.now() })
        .where(eq(lists.id, listId));
    } else {
      listId = randomUUID();
      await db.insert(lists).values({
        id: listId,
        userId,
        name: parsedList.name,
        source,
        importedAt: Date.now(),
      });
    }

    for (const parsedPlace of parsedList.places) {
      result.places += 1;
      const key = cacheKeyFor(parsedPlace);

      const cachedRows = await db
        .select()
        .from(placeCache)
        .where(eq(placeCache.key, key))
        .limit(1);
      const cached = cachedRows[0];

      if (cached) {
        // The place has been resolved before: zero API calls.
        result.cacheHits += 1;
      } else if (
        parsedPlace.lat !== undefined &&
        parsedPlace.lng !== undefined
      ) {
        // Coordinates came straight from Saved Places.json: zero API calls.
        await db
          .insert(placeCache)
          .values({
            key,
            placeId: null,
            name: parsedPlace.title,
            address: parsedPlace.address ?? null,
            lat: parsedPlace.lat,
            lng: parsedPlace.lng,
            category: null,
            types: null,
            fetchedAt: Date.now(),
          })
          .onConflictDoNothing();
      } else {
        // Resolve via the Places client and cache the outcome, including a
        // "miss" row so a failure is not retried on the next import.
        result.apiCalls += 1;
        const query =
          parsedPlace.title +
          (parsedPlace.address ? " " + parsedPlace.address : "");
        const found = await client.searchText(query);
        await db
          .insert(placeCache)
          .values({
            key,
            placeId: found?.placeId ?? null,
            name: found?.name ?? parsedPlace.title,
            address: found?.address ?? parsedPlace.address ?? null,
            lat: found?.lat ?? null,
            lng: found?.lng ?? null,
            category: found?.category ?? null,
            types: found ? JSON.stringify(found.types) : null,
            fetchedAt: Date.now(),
          })
          .onConflictDoNothing();
      }

      await db.insert(places).values({
        id: randomUUID(),
        listId,
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
  }

  return result;
}
