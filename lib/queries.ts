import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { lists, placeCache, places } from "./db/schema";

// A place as presented to the UI, joined with its enrichment cache.
export interface PlaceView {
  id: string;
  title: string;
  note: string | null;
  mapsUrl: string | null;
  address: string | null;
  category: string | null;
  lat: number | null;
  lng: number | null;
}

// A list plus its resolved places and a place count.
export interface ListView {
  id: string;
  name: string;
  count: number;
  places: PlaceView[];
}

// Load every list owned by a user, each with its enriched places. This runs in
// a server component, so it must only be reached from dynamic routes.
export function loadLists(userId: string): ListView[] {
  const db = getDb();

  const userLists = db
    .select()
    .from(lists)
    .where(eq(lists.userId, userId))
    .all();

  const views: ListView[] = [];
  for (const list of userLists) {
    const rows = db
      .select({
        id: places.id,
        title: places.title,
        note: places.note,
        mapsUrl: places.mapsUrl,
        address: placeCache.address,
        category: placeCache.category,
        lat: placeCache.lat,
        lng: placeCache.lng,
      })
      .from(places)
      .leftJoin(placeCache, eq(places.cacheKey, placeCache.key))
      .where(eq(places.listId, list.id))
      .all();

    views.push({
      id: list.id,
      name: list.name,
      count: rows.length,
      places: rows,
    });
  }

  // Present lists alphabetically for a stable left column.
  views.sort((a, b) => a.name.localeCompare(b.name));
  return views;
}
