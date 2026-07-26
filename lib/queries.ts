import { and, eq } from "drizzle-orm";
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

// Load every non-hidden list owned by a user, each with its enriched places.
// This runs in a server component, so it must only be reached from dynamic
// routes.
export async function loadLists(userId: string): Promise<ListView[]> {
  const db = await getDb();

  const userLists = await db
    .select()
    .from(lists)
    .where(and(eq(lists.userId, userId), eq(lists.hidden, false)));

  const views: ListView[] = [];
  for (const list of userLists) {
    const rows = await db
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
      .where(eq(places.listId, list.id));

    views.push({
      id: list.id,
      name: list.name,
      count: rows.length,
      places: rows,
    });
  }

  // Pin these built-in lists to the top, in this order, then the rest
  // alphabetically for a stable left column, and force "Favorite places" to the
  // very bottom. "Saved Places" is the starred-places list (shown as "Starred
  // places" in the UI).
  const pinnedTop = ["Want to go", "Saved Places"];
  const rank = (name: string) => {
    if (name === "Favorite places") return pinnedTop.length + 1; // always last
    const i = pinnedTop.indexOf(name);
    return i === -1 ? pinnedTop.length : i;
  };
  views.sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return views;
}
