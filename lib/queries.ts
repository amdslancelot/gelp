import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import {
  lists,
  placeCache,
  placeCoords,
  placeQueue,
  places,
} from "./db/schema";
import { resolveShare } from "./share";
import { queueSummary, type QueueSummary } from "./import";
import {
  UNLOCATED_LIST_ID,
  UNLOCATED_LIST_NAME,
  type ListView,
  type PlaceView,
} from "./place-view";

// The view shapes live in `place-view`, which has no database imports, so a
// client component can read them without pulling the Postgres driver into the
// browser bundle. Re-exported here because this is where they are produced.
export type { QueueSummary } from "./import";
export type { PlaceView, ListView } from "./place-view";
export {
  UNLOCATED_LIST_ID,
  UNLOCATED_LIST_NAME,
  unlocatedReason,
  type UnlocatedReason,
} from "./place-view";

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
    // `place_coords` first, because it is the only source that is certainly
    // right: those rows were read off each place's own map page. `place_cache`
    // holds whatever a text search guessed, and is a fallback.
    //
    // Preferring it *here*, on the read, and not only during import, is what
    // makes a correction visible immediately. A user flags a pin, a resolve run
    // writes the real coordinates, and the map is right on the next page load —
    // rather than at whatever hour the next import happens to run.
    const rows = await db
      .select({
        id: places.id,
        title: places.title,
        note: places.note,
        mapsUrl: places.mapsUrl,
        // Same precedence as the coordinates, for the same reason: an address
        // read off the place's own page beats one a text search guessed at.
        // Without this a corrected pin sits in Bali under a San Francisco
        // address, which reads as a bug in the map rather than in the text.
        address: sql<
          string | null
        >`coalesce(${placeCoords.address}, ${placeCache.address})`,
        category: sql<
          string | null
        >`coalesce(${placeCoords.category}, ${placeCache.category})`,
        lat: sql<
          number | null
        >`coalesce(${placeCoords.lat}, ${placeCache.lat})`,
        lng: sql<
          number | null
        >`coalesce(${placeCoords.lng}, ${placeCache.lng})`,
        resolver: sql<
          string | null
        >`case when ${placeCoords.lat} is not null then 'coords' else ${placeCache.resolver} end`,
        status: placeCache.status,
        queued: sql<boolean>`${placeQueue.status} = 'pending'`,
      })
      .from(places)
      .leftJoin(placeCache, eq(places.cacheKey, placeCache.key))
      .leftJoin(placeCoords, eq(places.cid, placeCoords.cid))
      .leftJoin(placeQueue, eq(places.mapsUrl, placeQueue.mapsUrl))
      .where(eq(places.listId, list.id));

    views.push({
      id: list.id,
      name: list.name,
      count: rows.length,
      places: rows.map((r) => ({ ...r, queued: r.queued ?? false })),
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

  // A place with no coordinates is on no map, and a place on no map is one the
  // user never sees — so it can never be reported as wrong, and would sit
  // unlocated forever. Gathering them into one list at the bottom is what makes
  // them visible enough to act on.
  const unlocated = new Map<string, PlaceView>();
  for (const view of views) {
    for (const place of view.places) {
      if (place.lat !== null && place.lng !== null) continue;
      // The same place in three lists is one problem, not three.
      const key = place.mapsUrl ?? place.id;
      if (!unlocated.has(key)) unlocated.set(key, place);
    }
  }
  if (unlocated.size > 0) {
    views.push({
      id: UNLOCATED_LIST_ID,
      name: UNLOCATED_LIST_NAME,
      count: unlocated.size,
      places: [...unlocated.values()].sort((a, b) =>
        a.title.localeCompare(b.title),
      ),
    });
  }

  return views;
}

// Count what is on the resolve queue, for the import page.
export async function loadQueueSummary(): Promise<QueueSummary> {
  return queueSummary(await getDb());
}

// A map as seen by someone holding a share link.
export interface SharedMap {
  // The owner's display name, for a "shared by" line. Their email is
  // deliberately not part of this: the link is meant to be passed around, and
  // an address is not something the owner chose to hand out with it.
  ownerName: string | null;
  lists: ListView[];
}

// Resolve a share token to the map it points at, or null if no such token
// exists — which is also what a revoked link now looks like.
//
// This is the one read path with no session behind it, so it takes the token as
// its only authority and derives the user id from the row: nothing here trusts
// a user id supplied by the caller.
export async function loadSharedMap(token: string): Promise<SharedMap | null> {
  const db = await getDb();

  const share = await resolveShare(db, token);
  if (!share) return null;

  // Hidden lists stay hidden: loadLists already filters them out, so a list the
  // owner hid is not exposed by the share link either.
  return { ownerName: share.ownerName, lists: await loadLists(share.userId) };
}
