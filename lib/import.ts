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
): Promise<ImportResult> {
  const result: ImportResult = {
    lists: 0,
    places: 0,
    cacheHits: 0,
    apiCalls: 0,
  };

  for (const parsedList of parsed.lists) {
    result.lists += 1;

    // Upsert the list by (user_id, name).
    const existing = db
      .select()
      .from(lists)
      .where(and(eq(lists.userId, userId), eq(lists.name, parsedList.name)))
      .get();

    let listId: string;
    if (existing) {
      listId = existing.id;
      // Replace the list's places on re-import.
      db.delete(places).where(eq(places.listId, listId)).run();
      db.update(lists)
        .set({ source, importedAt: Date.now() })
        .where(eq(lists.id, listId))
        .run();
    } else {
      listId = randomUUID();
      db.insert(lists)
        .values({
          id: listId,
          userId,
          name: parsedList.name,
          source,
          importedAt: Date.now(),
        })
        .run();
    }

    for (const parsedPlace of parsedList.places) {
      result.places += 1;
      const key = cacheKeyFor(parsedPlace);

      const cached = db
        .select()
        .from(placeCache)
        .where(eq(placeCache.key, key))
        .get();

      if (cached) {
        // The place has been resolved before: zero API calls.
        result.cacheHits += 1;
      } else if (
        parsedPlace.lat !== undefined &&
        parsedPlace.lng !== undefined
      ) {
        // Coordinates came straight from Saved Places.json: zero API calls.
        db.insert(placeCache)
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
          .onConflictDoNothing()
          .run();
      } else {
        // Resolve via the Places client and cache the outcome, including a
        // "miss" row so a failure is not retried on the next import.
        result.apiCalls += 1;
        const query =
          parsedPlace.title +
          (parsedPlace.address ? " " + parsedPlace.address : "");
        const found = await client.searchText(query);
        db.insert(placeCache)
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
          .onConflictDoNothing()
          .run();
      }

      db.insert(places)
        .values({
          id: randomUUID(),
          listId,
          userId,
          title: parsedPlace.title,
          note: parsedPlace.note ?? null,
          mapsUrl: parsedPlace.mapsUrl ?? null,
          cacheKey: key,
        })
        .run();
    }
  }

  return result;
}
