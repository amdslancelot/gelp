import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "./db";
import {
  lists,
  placeCache,
  placeCoords,
  placeQueue,
  places,
} from "./db/schema";
import { nearBox, type NearFilter } from "./geo";
import { resolveShare } from "./share";
import { queueSummary, type QueueSummary } from "./import";
import {
  ALL_PLACES_LIST_ID,
  ALL_PLACES_LIST_NAME,
  UNLOCATED_LIST_ID,
  UNLOCATED_LIST_NAME,
  type ListSummary,
  type PlaceView,
} from "./place-view";

// The view shapes live in `place-view`, which has no database imports, so a
// client component can read them without pulling the Postgres driver into the
// browser bundle. Re-exported here because this is where they are produced.
export type { QueueSummary } from "./import";
export type { PlaceView, ListSummary } from "./place-view";
export {
  ALL_PLACES_LIST_ID,
  ALL_PLACES_LIST_NAME,
  UNLOCATED_LIST_ID,
  UNLOCATED_LIST_NAME,
  unlocatedReason,
  type UnlocatedReason,
} from "./place-view";

// The columns a `PlaceView` is built from, with the joins that fill them in.
//
// `place_coords` first, because it is the only source that is certainly right:
// those rows were read off each place's own map page. `place_cache` holds
// whatever a text search guessed, and is a fallback.
//
// Preferring it *here*, on the read, and not only during import, is what makes
// a correction visible immediately. A user flags a pin, a resolve run writes
// the real coordinates, and the map is right on the next page load — rather
// than at whatever hour the next import happens to run.
function placeRowQuery(db: Db) {
  return db
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
      // A saved shopping item or film has no position, whatever the cache says
      // about the URL it was saved under. Suppressed here rather than repaired
      // in the cache, because the cache row may be shared with entries this is
      // not true of, and because the flag is recomputed every import while a
      // repaired cache row would have to be kept right forever.
      //
      // This is what stops a text search that once matched "BMW Z4 front
      // bumper" to a real body shop from putting a pin on it.
      lat: sql<
        number | null
      >`case when ${places.notAPlace} then null
             else coalesce(${placeCoords.lat}, ${placeCache.lat}) end`,
      lng: sql<
        number | null
      >`case when ${places.notAPlace} then null
             else coalesce(${placeCoords.lng}, ${placeCache.lng}) end`,
      // Why the coordinates above are what they are. `not_a_place` wins over
      // everything: it is the reason there is no position, and the UI reads it
      // to say so — and to withhold a Report button from a saved shirt.
      resolver: sql<string | null>`case
        when ${places.notAPlace} then 'not_a_place'
        when ${placeCoords.lat} is not null then 'coords'
        else ${placeCache.resolver} end`,
      // Nothing about a closed listing looks different otherwise, so this is
      // the only way it reaches the page at all.
      closed: placeCoords.closed,
      status: placeCache.status,
      queued: sql<boolean>`${placeQueue.status} = 'pending'`,
    })
    .from(places)
    .leftJoin(placeCache, eq(places.cacheKey, placeCache.key))
    .leftJoin(placeCoords, eq(places.cid, placeCoords.cid))
    .leftJoin(placeQueue, eq(places.mapsUrl, placeQueue.mapsUrl));
}

// True where a place has no position from either source. Written once because
// the unlocated list and its count have to agree on what "unlocated" means.
//
// A non-place is unlocated by definition, however confidently a cached search
// answered for its URL. Kept in step with the `lat` column above: if these two
// disagreed, a place would be on the map and in the "No coordinates" list at
// once, or in neither.
const hasNoPosition = sql`${places.notAPlace}
  or coalesce(${placeCoords.lat}, ${placeCache.lat}) is null`;

// Its exact complement, written as a negation of the same expression rather
// than spelled out again: "All Places" and "No coordinates" partition the
// account, and two hand-written conditions would eventually disagree about a
// place and put it in both or neither. `not_a_place` is NOT NULL, so this
// cannot go three-valued.
const hasPosition = sql`not (${hasNoPosition})`;

// The position a place is filtered on: the same coalesce the `lat`/`lng`
// columns use, so a place is inside the "near me" box exactly when the pin the
// user would see is. `not_a_place` is not tested here — it has no position, so
// it fails the null test below on its own.
const posLat = sql`coalesce(${placeCoords.lat}, ${placeCache.lat})`;
const posLng = sql`coalesce(${placeCoords.lng}, ${placeCache.lng})`;

// Restrict to a box around the user. Returns undefined for no filter, so it can
// be dropped into an `and(...)` unconditionally.
//
// A viewport straddling the antimeridian is written as two ranges rather than
// one, because there the box's west edge is a larger number than its east one
// and a plain BETWEEN matches nothing — which would show a user in Fiji an
// empty map and no reason for it.
function withinNear(near: NearFilter | undefined) {
  if (!near) return undefined;
  const { minLat, maxLat, minLng, maxLng } = nearBox(near);
  const lngTest =
    minLng < -180 || maxLng > 180
      ? // Normalised into [-180, 180] and tested as a union of the two halves.
        sql`(${posLng} >= ${((minLng + 540) % 360) - 180}
             or ${posLng} <= ${((maxLng + 540) % 360) - 180})`
      : sql`${posLng} between ${minLng} and ${maxLng}`;
  return sql`${posLat} between ${minLat} and ${maxLat} and ${lngTest}`;
}

// Pin these built-in lists to the top, in this order, then the rest
// alphabetically for a stable left column, and force "Favorite places" to the
// very bottom. "Saved Places" is the starred-places list (shown as "Starred
// places" in the UI).
const PINNED_TOP = ["Want to go", "Saved Places"];
function listRank(name: string): number {
  if (name === "Favorite places") return PINNED_TOP.length + 1; // always last
  const i = PINNED_TOP.indexOf(name);
  return i === -1 ? PINNED_TOP.length : i;
}

// Every non-hidden list owned by a user, named and counted but without its
// places. This is what a page load carries: the places for whichever list is
// open are fetched separately.
//
// The split exists because the alternative was measured — serialising every
// place in the account into the HTML put 2.3 MB on the wire for an account with
// 5473 of them, to show one list of which only a screenful is ever read.
export async function loadListSummaries(
  userId: string,
): Promise<ListSummary[]> {
  const db = await getDb();

  const rows = await db
    .select({
      id: lists.id,
      name: lists.name,
      count: sql<number>`count(${places.id})::int`,
    })
    .from(lists)
    .leftJoin(places, eq(places.listId, lists.id))
    .where(and(eq(lists.userId, userId), eq(lists.hidden, false)))
    .groupBy(lists.id, lists.name);

  const summaries = rows.sort(
    (a, b) => listRank(a.name) - listRank(b.name) || a.name.localeCompare(b.name),
  );

  // Every placed place in the account, gathered above the real lists. Google's
  // export splits the same place across "Want to go", "Favorites" and whatever
  // else it was saved to, so there was no single view of the map until this —
  // opening each list in turn was the only way to see all of the pins.
  //
  // Deduped by the same key the list itself uses, so the count in the sidebar
  // and the number of rows in the column agree.
  const [{ count: allCount }] = await db
    .select({
      count: sql<number>`count(distinct coalesce(${places.mapsUrl}, ${places.id}))::int`,
    })
    .from(places)
    .leftJoin(placeCache, eq(places.cacheKey, placeCache.key))
    .leftJoin(placeCoords, eq(places.cid, placeCoords.cid))
    .innerJoin(lists, eq(places.listId, lists.id))
    .where(and(eq(lists.userId, userId), eq(lists.hidden, false), hasPosition));

  if (allCount > 0) {
    summaries.unshift({
      id: ALL_PLACES_LIST_ID,
      name: ALL_PLACES_LIST_NAME,
      count: allCount,
    });
  }

  // A place with no coordinates is on no map, and a place on no map is one the
  // user never sees — so it can never be reported as wrong, and would sit
  // unlocated forever. Gathering them into one list at the bottom is what makes
  // them visible enough to act on.
  //
  // Counted with the same dedupe the list itself uses: the same place saved to
  // three lists is one problem, not three.
  const [{ count: unlocatedCount }] = await db
    .select({
      count: sql<number>`count(distinct coalesce(${places.mapsUrl}, ${places.id}))::int`,
    })
    .from(places)
    .leftJoin(placeCache, eq(places.cacheKey, placeCache.key))
    .leftJoin(placeCoords, eq(places.cid, placeCoords.cid))
    .innerJoin(lists, eq(places.listId, lists.id))
    .where(
      and(eq(lists.userId, userId), eq(lists.hidden, false), hasNoPosition),
    );

  if (unlocatedCount > 0) {
    summaries.push({
      id: UNLOCATED_LIST_ID,
      name: UNLOCATED_LIST_NAME,
      count: unlocatedCount,
    });
  }

  return summaries;
}

// The places of one list, enriched. `listId` arrives from the client, so
// ownership is established here rather than assumed: a request for a list the
// user does not own, or one they have hidden, returns nothing at all rather
// than an error that would confirm the list exists.
async function listPlaces(
  db: Db,
  userId: string,
  listId: string,
  near?: NearFilter,
): Promise<PlaceView[]> {
  if (listId === ALL_PLACES_LIST_ID) return everyPlace(db, userId, near);
  // The unlocated list ignores `near`: nothing in it has a position, so any box
  // would empty it. It is also small, which is why it never needed one.
  if (listId === UNLOCATED_LIST_ID) return unlocatedPlaces(db, userId);

  const owned = await db
    .select({ id: lists.id })
    .from(lists)
    .where(
      and(
        eq(lists.id, listId),
        eq(lists.userId, userId),
        eq(lists.hidden, false),
      ),
    )
    .limit(1);
  if (owned.length === 0) return [];

  const rows = await placeRowQuery(db).where(
    and(eq(places.listId, listId), withinNear(near)),
  );
  return rows.map((r) => ({ ...r, queued: r.queued ?? false }));
}

// The built-in list of everything that is on the map, assembled across all of
// the user's non-hidden lists.
//
// This is the largest query the app runs, and the only one that can return the
// whole account at once — which is why the page does not server-render it (see
// `app/page.tsx`): it arrives through the same fetch every other list uses.
async function everyPlace(
  db: Db,
  userId: string,
  near?: NearFilter,
): Promise<PlaceView[]> {
  const rows = await placeRowQuery(db)
    .innerJoin(lists, eq(places.listId, lists.id))
    .where(
      and(
        eq(lists.userId, userId),
        eq(lists.hidden, false),
        hasPosition,
        withinNear(near),
      ),
    );

  const seen = new Map<string, PlaceView>();
  for (const row of rows) {
    const place = { ...row, queued: row.queued ?? false };
    // The same place saved to three lists is one pin, not three stacked on the
    // same spot. Same key as the unlocated list, for the same reason.
    const key = place.mapsUrl ?? place.id;
    if (!seen.has(key)) seen.set(key, place);
  }
  return [...seen.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// The built-in list of places nothing could put on a map, assembled across all
// of the user's non-hidden lists.
async function unlocatedPlaces(
  db: Db,
  userId: string,
): Promise<PlaceView[]> {
  const rows = await placeRowQuery(db)
    .innerJoin(lists, eq(places.listId, lists.id))
    .where(
      and(eq(lists.userId, userId), eq(lists.hidden, false), hasNoPosition),
    );

  const unlocated = new Map<string, PlaceView>();
  for (const row of rows) {
    const place = { ...row, queued: row.queued ?? false };
    // The same place in three lists is one problem, not three.
    const key = place.mapsUrl ?? place.id;
    if (!unlocated.has(key)) unlocated.set(key, place);
  }
  return [...unlocated.values()].sort((a, b) => a.title.localeCompare(b.title));
}

// The places of one of the session user's lists.
export async function loadListPlaces(
  userId: string,
  listId: string,
  near?: NearFilter,
): Promise<PlaceView[]> {
  return listPlaces(await getDb(), userId, listId, near);
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
  lists: ListSummary[];
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

  // Hidden lists stay hidden: loadListSummaries already filters them out, so a
  // list the owner hid is not exposed by the share link either.
  return {
    ownerName: share.ownerName,
    lists: await loadListSummaries(share.userId),
  };
}

// The places of one list on a shared map. Same authority as the page itself:
// the token names the owner, and the caller's list id is then checked against
// that owner — so a share link can only ever read the map it points at.
export async function loadSharedListPlaces(
  token: string,
  listId: string,
  near?: NearFilter,
): Promise<PlaceView[] | null> {
  const db = await getDb();

  const share = await resolveShare(db, token);
  if (!share) return null;

  return listPlaces(db, share.userId, listId, near);
}
