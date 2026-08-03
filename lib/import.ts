import { randomUUID } from "node:crypto";
import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "./db";
import {
  lists,
  placeCache,
  placeCoords,
  placeQueue,
  tombstoneCid,
  places,
  type PlaceCache,
  type PlaceCoords,
} from "./db/schema";
import {
  cidFromMapsUrl,
  isPlaceEntry,
  regionKeyFromMapsUrl,
  type ParsedPlace,
  type ParsedTakeout,
} from "./takeout";
import type { PlaceLookup, PlacesClient } from "./places";
import {
  RegionAnchors,
  consensusCenters,
  haversineMeters,
  type Point,
} from "./geo";

// Counts returned from an import run, useful for the upload UI and logs.
export interface ImportResult {
  lists: number;
  places: number;
  cacheHits: number;
  apiCalls: number;
  // Lists deleted because the export no longer contains them.
  listsRemoved: number;
  // Places put on the resolve queue rather than guessed at.
  queued: number;
  // Places a queued import skipped because their Google id is dead. Resolving
  // one means opening its map page by id, and there is no page to open.
  gone: number;
}

// How an import resolves the places whose position it does not already know.
//
//   fast   — ask the Places API, which answers immediately and sometimes wrong,
//            because it is matching a name rather than identifying a place.
//   queued — ask nobody. Enqueue them instead, to be read off their own map
//            pages later. Nothing is guessed and nothing is billed, at the cost
//            of those places having no pin until a resolve run happens.
//
// Neither affects a place already in `place_coords` or whose URL states its
// position: those are answered the same way either way, for free.
export type ImportMode = "fast" | "queued";

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

// A place is looked up once and the answer kept — including "no such place",
// which is an answer. Getting it wrong is not corrected by asking again, since
// asking again asks the same question of the same data; it is corrected by a
// user flagging the pin, which routes the place to `place_coords` instead.
//
// The one exception is a lookup that never happened. `unavailable` means the
// request itself failed — a network error, an HTTP error, no API key configured
// — which says nothing at all about the place. Keeping that permanently would
// mean a single outage during an import blanks those places forever, and a
// place with no coordinates does not appear on the map, so the user never sees
// it to flag it. So this one, and only this one, expires.
export const UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Where a cached row's coordinates came from. Provenance, not policy: none of
// these expires, because a place is looked up at most once.
export const RESOLVER_COORDS = "coords"; // mirrored from place_coords
export const RESOLVER_URL = "url"; // the export's URL named the position
export const RESOLVER_SEARCH = "search"; // the Places API guessed
export const RESOLVER_NOT_A_PLACE = "not_a_place"; // nothing was looked up

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
  // A lookup that failed says nothing about the place, so it is the only kind
  // worth repeating.
  if (row.status === "unavailable") {
    return now - row.fetchedAt < UNAVAILABLE_TTL_MS;
  }
  return true;
}

// Write one enrichment result, replacing an expired row for the same key, and
// return whatever the row now is.
//
// The guard keeps a resolved row resolved: if a concurrent import already
// answered this key, a lookup that came back empty here must not overwrite it
// with a blank. A resolved answer always wins over an unresolved one — in which
// case the update writes nothing and there is no returned row.
//
// The second clause is the same idea one level up: a row mirrored from
// `place_coords` was read off the place's own map page, so a search result may
// never replace it, whichever import gets there first.
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
      setWhere: sql`(${placeCache.status} <> 'ok' or excluded.status = 'ok')
        and (${placeCache.resolver} <> ${RESOLVER_COORDS}
             or excluded.resolver = ${RESOLVER_COORDS})`,
    })
    .returning();
  return stored;
}

// Put places on the resolve queue, leaving alone any already waiting.
//
// `onConflictDoNothing` rather than an update: a place already queued is
// already going to be resolved, and re-importing must not reset a row a run is
// partway through. A place that was resolved and has since gone wrong is
// re-opened by flagging it, which is a deliberate act, not by importing again.
export async function enqueuePlaces(
  db: Db,
  entries: Array<{ mapsUrl: string; title: string; note?: string }>,
  reason: "flagged" | "import",
  requestedBy: string | null,
): Promise<number> {
  if (entries.length === 0) return 0;

  // Never queue an id Google has already refused. A resolve run on one of
  // these cannot succeed — it opens a blank map and gives up — so queueing it
  // would leave a row that is retried on every run and never closes. Filtered
  // here rather than at each caller because both callers need it: an import
  // that sweeps up everything unresolved, and a user flagging a pin that the
  // built-in unlocated list showed them.
  const gone = await loadTombstones(
    db,
    entries.map((e) => cidFromMapsUrl(e.mapsUrl)),
  );
  const live = entries.filter((e) => {
    const cid = cidFromMapsUrl(e.mapsUrl);
    return !cid || !gone.has(cid);
  });
  if (live.length === 0) return 0;

  let added = 0;
  for (let i = 0; i < live.length; i += BATCH_SIZE) {
    const rows = live.slice(i, i + BATCH_SIZE).map((e) => ({
      id: randomUUID(),
      mapsUrl: e.mapsUrl,
      cid: cidFromMapsUrl(e.mapsUrl) ?? null,
      title: e.title,
      note: e.note ?? null,
      reason,
      requestedBy,
      status: "pending" as const,
      createdAt: Date.now(),
    }));
    const done = await db
      .insert(placeQueue)
      .values(rows)
      .onConflictDoNothing({ target: placeQueue.mapsUrl })
      .returning({ id: placeQueue.id });
    added += done.length;
  }
  return added;
}

// How many resolve runs may come away with nothing before a queue row stops
// being retried.
//
// Three rather than one, because the failures this counts are the transient
// kind: a consent wall, a slow page, a browser that died. Retrying is the whole
// point of leaving such a row pending. Three rather than ten, because a run is
// slow and deliberate — a row that has failed three separate runs is not going
// to come good on the fourth by luck, and a queue that never converges is one
// nobody can read.
//
// Crossing it is not a verdict on the place. A `failed` row is reopened by
// `dump-queue.ts --retry-failed`, which is a deliberate act, and the count that
// sent it there is reset then.
export const MAX_RESOLVE_ATTEMPTS = 3;

// How much work is waiting to have real coordinates read for it.
export interface QueueSummary {
  pending: number;
  // Split by who asked, because they read differently: places a user reported
  // as wrong are a complaint, places an import could not answer for are simply
  // not done yet.
  flagged: number;
  fromImport: number;
  // When the longest-waiting entry was queued, so a queue nobody is draining
  // says so rather than looking merely busy.
  oldestAt: number | null;
  // Rows that gave up after `MAX_RESOLVE_ATTEMPTS` runs. Counted separately
  // because they are the opposite of the number above: not work waiting, but
  // work abandoned — and abandoned silently, since nothing dumps them again.
  // Invisible failure is the thing this queue was built to avoid.
  failed: number;
}

// Count what is on the resolve queue.
//
// Not scoped to a user: the queue is global because the coordinates it produces
// are, and a place waiting there is waiting for everyone.
export async function queueSummary(db: Db): Promise<QueueSummary> {
  const rows = await db
    .select({
      reason: placeQueue.reason,
      count: sql<number>`count(*)::int`,
      oldest: sql<number | null>`min(${placeQueue.createdAt})`,
    })
    .from(placeQueue)
    .where(eq(placeQueue.status, "pending"))
    .groupBy(placeQueue.reason);

  const [gaveUp] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(placeQueue)
    .where(eq(placeQueue.status, "failed"));

  const summary: QueueSummary = {
    pending: 0,
    flagged: 0,
    fromImport: 0,
    oldestAt: null,
    failed: gaveUp?.count ?? 0,
  };
  for (const row of rows) {
    summary.pending += row.count;
    if (row.reason === "flagged") summary.flagged += row.count;
    else summary.fromImport += row.count;
    if (row.oldest !== null) {
      const at = Number(row.oldest);
      summary.oldestAt = summary.oldestAt === null ? at : Math.min(summary.oldestAt, at);
    }
  }
  return summary;
}

// The authoritative coordinates for every place in this list that has any, in
// one round trip per batch.
//
// This is the first thing consulted and it short-circuits everything after it:
// a place found here needs no search, no consensus, and no API call, now or
// ever again.
async function loadCoords(
  db: Db,
  cids: Array<string | undefined>,
): Promise<Map<string, PlaceCoords>> {
  const unique = [...new Set(cids.filter((c): c is string => Boolean(c)))];
  const found = new Map<string, PlaceCoords>();
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const rows = await db
      .select()
      .from(placeCoords)
      .where(inArray(placeCoords.cid, unique.slice(i, i + BATCH_SIZE)));
    for (const row of rows) if (row.cid) found.set(row.cid, row);
  }
  return found;
}

// Which of these ids Google has already been asked about and had no entry for.
//
// The distinction this preserves is between "not looked up yet" and "looked up,
// and there is nothing there". Only the first is worth spending a resolve run
// or an API call on; without the table they are the same thing, and the second
// is paid for over and over.
export async function loadTombstones(
  db: Db,
  cids: Array<string | undefined>,
): Promise<Set<string>> {
  const unique = [...new Set(cids.filter((c): c is string => Boolean(c)))];
  const gone = new Set<string>();
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const rows = await db
      .select({ cid: tombstoneCid.cid })
      .from(tombstoneCid)
      .where(inArray(tombstoneCid.cid, unique.slice(i, i + BATCH_SIZE)));
    for (const row of rows) gone.add(row.cid);
  }
  return gone;
}

// Ask the Places client for one place, aimed at wherever its region is known
// or believed to be.
//
// The aim is the whole point. `searchText` with a bare title is a *global*
// search: "zondag" in a Tokyo list matches every business on earth called that,
// and the winner is whichever one Google ranks highest overall — a café in
// Groningen. The same query aimed at Tokyo finds the Tokyo one, and if the API
// still insists on the Netherlands, the bias's distance limit rejects it.
async function search(
  client: PlacesClient,
  place: ParsedPlace,
  anchors: RegionAnchors,
  regionKey: string | undefined,
): Promise<PlaceLookup> {
  const query = place.title + (place.address ? " " + place.address : "");
  const bias = anchors.lookup(regionKey);
  return client.searchText(
    query,
    bias
      ? {
          bias: {
            lat: bias.center.lat,
            lng: bias.center.lng,
            biasMeters: bias.biasMeters,
            maxMeters: bias.maxMeters,
          },
        }
      : undefined,
  );
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

// Which of these places already have a row on the resolve queue.
//
// Matched on the Maps URL because that is what `place_queue` is unique on: the
// queue is global, so a place another account queued is already going to be
// resolved and is not new work for this one.
//
// Deliberately not scoped to `pending`. What stops a re-import adding a second
// entry is the unique constraint, which does not care what state the row is in
// — `enqueuePlaces` conflicts on the URL and does nothing. A dry run that
// counted only pending rows would report queue work that the import then would
// not do.
async function loadQueued(
  db: Db,
  urls: Array<string | undefined | null>,
): Promise<Set<string>> {
  const unique = [...new Set(urls.filter((u): u is string => Boolean(u)))];
  const waiting = new Set<string>();
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const rows = await db
      .select({ mapsUrl: placeQueue.mapsUrl })
      .from(placeQueue)
      .where(inArray(placeQueue.mapsUrl, unique.slice(i, i + BATCH_SIZE)));
    for (const row of rows) waiting.add(row.mapsUrl);
  }
  return waiting;
}

// The lists this account already has, and how many places are in each.
async function loadExistingLists(
  db: Db,
  userId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      name: lists.name,
      count: sql<number>`count(${places.id})::int`,
    })
    .from(lists)
    .leftJoin(places, eq(places.listId, lists.id))
    .where(eq(lists.userId, userId))
    .groupBy(lists.id, lists.name);
  return new Map(rows.map((r) => [r.name, r.count]));
}

// How each place in an export would be resolved if it were imported right now.
//
// Disjoint and exhaustive: every place falls in exactly one bucket, so these
// sum to the place count. The order they are tested in is the same precedence
// `runImport` uses, and deliberately so — a dry run that answered in a
// different order would describe an import that does not happen.
//
//   exact         — place_coords knows this place; correct, and free
//   fromUrl       — the export's own URL states the position; correct, and free
//   cached        — place_cache has it, mirrored from an exact source
//   cachedGuess   — place_cache has it, but a text search picked it
//   unverifiable  — the same guess, for a place whose id Google has dropped
//   cachedMissing — cached as unresolved: looked for before and not found
//   notPlace      — a saved shopping item or link; never had a position
//   alreadyQueued — already has a queue row, so re-importing adds nothing
//   gone          — Google has no entry under this id any more
//   unknown       — nobody has looked yet. This is the only bucket that costs
//                   anything: a queue entry, or a Places API call.
//
// `cached`, `cachedGuess` and `unverifiable` are one action — use the cached
// row, pay nothing — split by how much the answer can be trusted, which is the
// question the confirm screen exists to answer. The last of the three is the
// one worth naming: its coordinates were guessed from a title, and the place's
// own map page can no longer be opened to check, because Google has dropped the
// id. Nothing will ever correct it — a resolve run cannot, since there is no
// page to read, and flagging it cannot, since `enqueuePlaces` refuses
// tombstoned ids. The guess is the final answer.
export interface PlaceBuckets {
  exact: number;
  fromUrl: number;
  cached: number;
  cachedGuess: number;
  unverifiable: number;
  cachedMissing: number;
  notPlace: number;
  alreadyQueued: number;
  gone: number;
  unknown: number;
}

type Bucket = keyof PlaceBuckets;

function emptyBuckets(): PlaceBuckets {
  return {
    exact: 0,
    fromUrl: 0,
    cached: 0,
    cachedGuess: 0,
    unverifiable: 0,
    cachedMissing: 0,
    notPlace: 0,
    alreadyQueued: 0,
    gone: 0,
    unknown: 0,
  };
}

// A place in the export whose Google id is in `tombstone_cid`, listed rather
// than merely counted.
//
// It is listed because it is the one outcome the user can neither wait out nor
// report: no resolve run will reach it and no flag will queue it. Seeing which
// places they are is the only way to act — the fix is to open Google Maps and
// save the place again, which mints a new id.
export interface DeadPlace {
  title: string;
  mapsUrl: string;
  // The lists it appears in, since the same dead link is often saved twice.
  lists: string[];
  // True when a search's guess is standing in for it on the map, false when it
  // has no pin at all. Both are dead ids; only the first looks fine.
  guessed: boolean;
}

// How many dead-id places the analysis carries back. A cap, because this is a
// list to read, not a dataset — the count beside it is the honest total.
const DEAD_LIST_LIMIT = 200;

// One list in the export, and what importing it would do to the stored one.
export interface ListAnalysis {
  name: string;
  // Places the export has for this list.
  places: number;
  //   new     — no list of this name yet
  //   replace — a stored list of this name has its places swapped wholesale
  status: "new" | "replace";
  // Places the stored list has now. Zero for a new list.
  existing: number;
  buckets: PlaceBuckets;
}

// A stored list the export no longer contains, which importing would delete.
export interface RemovedList {
  name: string;
  places: number;
}

// What an import of this export would do, worked out without writing anything
// or asking Google anything.
export interface ImportAnalysis {
  lists: ListAnalysis[];
  // Lists that would be deleted, because a Takeout export is a complete
  // snapshot and anything missing from it was deleted in Google Maps.
  removed: RemovedList[];
  totals: PlaceBuckets;
  places: number;
  // A queued import would add this many queue entries: the unknown places,
  // deduplicated by URL, since the queue is unique on it.
  wouldQueue: number;
  // Places whose Google id is dead, deduplicated by URL. Listed, not just
  // counted, because nothing in the app will ever fix them on its own.
  dead: DeadPlace[];
  // How many there are in total, which is what `dead` is a capped view of.
  deadTotal: number;
  // Of those, how many currently have a guessed pin standing in for them. The
  // rest have no pin at all — more honest, and easier to notice.
  deadGuessed: number;
  // A fast import would make at least this many Places API calls: every place
  // nobody has an answer for, deduplicated by cache key. "At least" because the
  // consensus pass re-asks for answers that land far from their own region, and
  // how many those are is not knowable until the answers are in.
  wouldCallApi: number;
  // True when the export parsed to no lists at all. `runImport` deletes nothing
  // in that case — far more likely a broken download than an emptied account —
  // and the confirm screen should say so rather than showing an import that
  // appears to do nothing.
  emptyExport: boolean;
}

// Work out what importing this export would do, as a dry run.
//
// Reads only: no cache row is written, no queue entry added, no Places API call
// made. It answers the two questions worth asking before committing — how much
// of this is already known, and what would be deleted — using exactly the
// precedence `runImport` applies, so the numbers describe the import that would
// actually happen.
//
// The one thing it cannot promise is that they still hold at confirm time: the
// nightly Drive sync could land in between and resolve some of these places, or
// queue them. So the counts are an estimate of a moment, and the UI says so.
export async function analyzeImport(
  db: Db,
  userId: string,
  parsed: ParsedTakeout,
): Promise<ImportAnalysis> {
  const now = Date.now();
  const all = parsed.lists.flatMap((l) => l.places);

  // Everything the whole export needs, in one pass rather than per list. The
  // import loads these per list because it writes between lists; a dry run
  // writes nothing, so it can ask once.
  const cache = await loadCache(db, all.map(cacheKeyFor));
  const cids = all.map((p) => cidFromMapsUrl(p.mapsUrl));
  const coords = await loadCoords(db, cids);
  const gone = await loadTombstones(db, cids);
  const queued = await loadQueued(db, all.map((p) => p.mapsUrl));
  const existing = await loadExistingLists(db, userId);

  const bucketFor = (place: ParsedPlace): Bucket => {
    const cid = cidFromMapsUrl(place.mapsUrl);
    if (cid && coords.has(cid)) return "exact";
    if (place.lat !== undefined && place.lng !== undefined) return "fromUrl";
    if (!isPlaceEntry(place)) return "notPlace";
    const cached = cache.get(cacheKeyFor(place));
    if (cached && isCacheFresh(cached, now)) {
      if (cached.lat === null || cached.lng === null) return "cachedMissing";
      if (cached.resolver !== RESOLVER_SEARCH) return "cached";
      // A guess whose subject can no longer be looked at. The import does the
      // same thing either way — take the cached row — but a guess that can
      // still be corrected and one that never can are not the same answer.
      return cid && gone.has(cid) ? "unverifiable" : "cachedGuess";
    }
    if (cid && gone.has(cid)) return "gone";
    if (place.mapsUrl && queued.has(place.mapsUrl)) return "alreadyQueued";
    return "unknown";
  };

  const totals = emptyBuckets();
  // Deduplicated the same way the writes are, so the estimates count work
  // rather than places: the queue is unique on URL, and the cache on key.
  const queueUrls = new Set<string>();
  const lookupKeys = new Set<string>();
  // Every dead-id place, gathered by URL so the same dead link saved to three
  // lists reads as one problem in three places rather than three problems.
  const dead = new Map<string, DeadPlace>();

  const analysed: ListAnalysis[] = parsed.lists.map((list) => {
    const buckets = emptyBuckets();
    for (const place of list.places) {
      const bucket = bucketFor(place);
      buckets[bucket] += 1;
      totals[bucket] += 1;

      // A place with no Maps URL cannot be queued — there is no page to open —
      // so a queued import simply leaves it alone.
      if (bucket === "unknown" && place.mapsUrl) queueUrls.add(place.mapsUrl);
      // A fast import ignores both the queue and the tombstones: it asks by
      // title, which neither of them closes off.
      if (bucket === "unknown" || bucket === "alreadyQueued" || bucket === "gone") {
        lookupKeys.add(cacheKeyFor(place));
      }
      // The two buckets a dead id can land in: pinned by a guess, or not
      // pinned at all. Both mean the same thing about the link itself.
      if ((bucket === "unverifiable" || bucket === "gone") && place.mapsUrl) {
        const seen = dead.get(place.mapsUrl);
        if (seen) seen.lists.push(list.name);
        else
          dead.set(place.mapsUrl, {
            title: place.title,
            mapsUrl: place.mapsUrl,
            lists: [list.name],
            guessed: bucket === "unverifiable",
          });
      }
    }
    const stored = existing.get(list.name);
    return {
      name: list.name,
      places: list.places.length,
      status: stored === undefined ? "new" : "replace",
      existing: stored ?? 0,
      buckets,
    };
  });

  const importedNames = new Set(parsed.lists.map((l) => l.name));
  const removed: RemovedList[] =
    parsed.lists.length === 0
      ? []
      : [...existing.entries()]
          .filter(([name]) => !importedNames.has(name))
          .map(([name, places]) => ({ name, places }));

  // Guessed pins first: they are the ones that look answered and are not, so
  // they are what a reader should meet at the top of the list.
  const deadList = [...dead.values()].sort(
    (a, b) =>
      Number(b.guessed) - Number(a.guessed) || a.title.localeCompare(b.title),
  );

  return {
    lists: analysed,
    removed,
    totals,
    places: all.length,
    wouldQueue: queueUrls.size,
    wouldCallApi: lookupKeys.size,
    dead: deadList.slice(0, DEAD_LIST_LIMIT),
    deadTotal: deadList.length,
    deadGuessed: deadList.filter((d) => d.guessed).length,
    emptyExport: parsed.lists.length === 0,
  };
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
  mode: ImportMode = "fast",
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  const result: ImportResult = {
    lists: 0,
    places: 0,
    cacheHits: 0,
    apiCalls: 0,
    listsRemoved: 0,
    queued: 0,
    gone: 0,
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

    // Google's id for each place, and the coordinates already known for those
    // ids. This is the top of the precedence chain: place_coords, then a
    // position the URL states outright, then the cache, then a search.
    const cids = parsedList.places.map((p) => cidFromMapsUrl(p.mapsUrl));
    const coords = await loadCoords(db, cids);

    // Ids a resolve run has already found Google has no entry for. Consulted
    // only by the queued path below: this closes the id-based route, not the
    // search-by-title one.
    const gone = await loadTombstones(db, cids);

    // Resolve the exact position of a place, if one is known without asking
    // anybody. Both sources are facts rather than guesses, so either ends the
    // question for good.
    const exactFor = (
      index: number,
      parsedPlace: ParsedPlace,
    ): { lat: number; lng: number; resolver: string } | undefined => {
      const cid = cids[index];
      const known = cid ? coords.get(cid) : undefined;
      if (known) {
        return { lat: known.lat, lng: known.lng, resolver: RESOLVER_COORDS };
      }
      if (parsedPlace.lat !== undefined && parsedPlace.lng !== undefined) {
        return {
          lat: parsedPlace.lat,
          lng: parsedPlace.lng,
          resolver: RESOLVER_URL,
        };
      }
      return undefined;
    };

    // The region each place belongs to, from the feature id in its Maps URL.
    // Opaque, but it groups places that are near each other, which is what
    // makes the consensus below possible for a list carrying no coordinates.
    const regions = parsedList.places.map((p) =>
      regionKeyFromMapsUrl(p.mapsUrl),
    );

    // Positions known before a single call goes out: coordinates the export
    // carried, and places a previous import already resolved.
    const anchors = new RegionAnchors();
    const samples: Array<{ regionKey?: string; point: Point }> = [];
    const addKnown = (index: number, lat: number, lng: number) => {
      anchors.add(regions[index], { lat, lng });
      samples.push({ regionKey: regions[index], point: { lat, lng } });
    };

    for (const [index, parsedPlace] of parsedList.places.entries()) {
      const exact = exactFor(index, parsedPlace);
      if (exact) {
        addKnown(index, exact.lat, exact.lng);
        continue;
      }
      const cached = cache.get(keys[index]);
      if (
        cached &&
        isCacheFresh(cached, Date.now()) &&
        cached.lat !== null &&
        cached.lng !== null
      ) {
        addKnown(index, cached.lat, cached.lng);
      }
    }

    // Pass 1 — resolve everything, aiming each lookup with whatever is known by
    // the time it goes out. Results are held rather than written: the region a
    // list belongs to is not settled until they are all in.
    const lookups = new Map<string, PlaceLookup>();
    // In queued mode, what to enqueue instead of looking up.
    const queued = new Map<string, ParsedPlace>();
    for (const [index, parsedPlace] of parsedList.places.entries()) {
      result.places += 1;
      const key = keys[index];
      const cached = cache.get(key);

      if (exactFor(index, parsedPlace)) {
        // Nothing to resolve — the position is already known for certain.
      } else if (!isPlaceEntry(parsedPlace)) {
        // A saved shopping item or web link, not somewhere on a map. Searching
        // for its title would return a real business with a similar name and
        // pin it, inventing a place the user never saved — and bill for it.
      } else if (cached && isCacheFresh(cached, Date.now())) {
        result.cacheHits += 1;
      } else if (mode === "queued" && cids[index] && gone.has(cids[index]!)) {
        // Only the id-based route is closed. A resolve run would open this
        // place's map page by its feature id, and Google has no page under
        // that id — so queueing it is queueing work that cannot be done.
        //
        // A text search is untouched by this. It asks by title and never held
        // the id, so it loses nothing when the id dies: `fast` mode still
        // searches, and often finds the place, because the place is usually
        // still there. What died is Google's reference to it.
        result.gone += 1;
      } else if (mode === "queued") {
        // Nobody is asked. The place goes on the queue to be read off its own
        // map page, which is slow but simply correct — and leaves no wrong pin
        // in the meantime, because it leaves no pin at all.
        queued.set(key, parsedPlace);
      } else if (!lookups.has(key)) {
        // A place repeated inside one list is resolved once: the second
        // appearance shares the first's answer rather than paying for its own.
        result.apiCalls += 1;
        lookups.set(key, await search(client, parsedPlace, anchors, regions[index]));
      } else {
        result.cacheHits += 1;
      }

      onProgress?.({
        processed: result.places,
        total: totalPlaces,
        listsDone: result.lists - 1,
        totalLists,
        currentList: parsedList.name,
      });
    }

    // A queued import stops here: it made no guesses, so there is nothing to
    // reach consensus about and nothing to write to the cache. The places it
    // could not answer for are on the queue, and will have real coordinates
    // once a resolve run works through it.
    if (queued.size > 0) {
      // Counted from what the insert actually added, not from what this list
      // wanted to add: a place another import already queued is not new work,
      // and reporting it as such would make a re-import look busy when it did
      // nothing at all.
      result.queued += await enqueuePlaces(
        db,
        [...queued.values()]
          .filter((p) => p.mapsUrl)
          .map((p) => ({ mapsUrl: p.mapsUrl!, title: p.title })),
        "import",
        userId,
      );
    }

    // Pass 2 — consensus. Fold this pass's answers in with what was already
    // known, find where each region's answers agree, and re-aim the ones that
    // landed far from that agreement. Only the outliers cost a second call.
    for (let index = 0; index < parsedList.places.length; index += 1) {
      const lookup = lookups.get(keys[index]);
      if (lookup?.status === "ok") {
        samples.push({
          regionKey: regions[index],
          point: { lat: lookup.place.lat, lng: lookup.place.lng },
        });
      }
    }

    const consensus = new RegionAnchors();
    for (const { key: regionKey, point } of consensusCenters(samples)) {
      consensus.add(regionKey, point);
    }
    // Known-exact positions outrank a consensus of search results, so they go
    // in too, at full precision.
    for (const [index, parsedPlace] of parsedList.places.entries()) {
      const exact = exactFor(index, parsedPlace);
      if (exact) consensus.add(regions[index], { lat: exact.lat, lng: exact.lng });
    }

    if (consensus.size > 0) {
      const retried = new Set<string>();
      for (const [index, parsedPlace] of parsedList.places.entries()) {
        const key = keys[index];
        const lookup = lookups.get(key);
        if (lookup?.status !== "ok" || retried.has(key)) continue;
        const bias = consensus.lookup(regions[index]);
        if (!bias) continue;
        const away = haversineMeters(bias.center, {
          lat: lookup.place.lat,
          lng: lookup.place.lng,
        });
        if (away <= bias.maxMeters) continue;

        // This answer is somewhere its own region is not. Ask again, aimed —
        // and if the second answer is no better, record that we did not find
        // the place rather than pinning it where it plainly is not.
        retried.add(key);
        result.apiCalls += 1;
        lookups.set(key, await search(client, parsedPlace, consensus, regions[index]));
      }
    }

    // Pass 3 — write the cache and build the rows to insert. One write per
    // distinct key: a place listed twice shares a single cache row.
    const written = new Set<string>();
    for (const [index, parsedPlace] of parsedList.places.entries()) {
      const key = keys[index];
      const exact = exactFor(index, parsedPlace);
      const first = !written.has(key);
      written.add(key);

      if (!first) {
        // Nothing to write; the row this key needs is already in.
      } else if (exact) {
        // The position is known for certain — from place_coords, or from a URL
        // that names it. Mirror it into the cache so anything reading only the
        // cache is right too, and so the next import sees it without the join.
        //
        // The mirror is never the authority: `place_coords` is consulted ahead
        // of it here, and the read path prefers it as well. So a coordinate
        // corrected after a user flags it takes effect immediately, without
        // waiting for this mirror to catch up on the next import.
        const row: PlaceCache = {
          key,
          placeId: null,
          name: parsedPlace.title,
          address: parsedPlace.address ?? null,
          lat: exact.lat,
          lng: exact.lng,
          category: null,
          types: null,
          status: "ok",
          resolver: exact.resolver,
          fetchedAt: Date.now(),
        };
        cache.set(key, (await writeCache(db, row)) ?? row);
      } else if (!isPlaceEntry(parsedPlace)) {
        // Recorded rather than left blank, so it is clear this has no
        // coordinates because it is not a place — not because a lookup failed.
        // The UI uses that distinction: a saved shirt is not something the user
        // can usefully flag as pinned in the wrong spot.
        const row: PlaceCache = {
          key,
          placeId: null,
          name: parsedPlace.title,
          address: null,
          lat: null,
          lng: null,
          category: null,
          types: null,
          status: "not_found",
          resolver: RESOLVER_NOT_A_PLACE,
          fetchedAt: Date.now(),
        };
        cache.set(key, (await writeCache(db, row)) ?? row);
      } else {
        const lookup = lookups.get(key);
        if (lookup) {
          // Cache the outcome — misses included, so a genuine miss is not
          // re-billed on every import. The row records *why* it is unresolved,
          // which is what decides whether a later import retries it.
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
            resolver: RESOLVER_SEARCH,
            fetchedAt: Date.now(),
          };
          cache.set(key, (await writeCache(db, row)) ?? row);
        }
      }

      enriched.push({
        id: randomUUID(),
        // Filled in inside the transaction, once the list row is known.
        listId: "",
        userId,
        title: parsedPlace.title,
        note: parsedPlace.note ?? null,
        mapsUrl: parsedPlace.mapsUrl ?? null,
        // Null when nothing was cached for this place — a queued import writes
        // no cache row, because it has nothing to say about where the place is
        // yet. The column is a foreign key, so it cannot point at a row that
        // was never written.
        cacheKey: cache.has(key) ? key : null,
        cid: cids[index] ?? null,
        // Derived here rather than read back from the cache, because the cache
        // is keyed by URL and shared: two unrelated saved items with the same
        // URL get one cache row between them, and this is a fact about the
        // entry. Recomputed every import, which is free — it is a regex over a
        // URL — and cannot go stale as a result.
        notAPlace: !isPlaceEntry(parsedPlace),
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
