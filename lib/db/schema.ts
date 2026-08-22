import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  unique,
} from "drizzle-orm/pg-core";

// Timestamps are stored as epoch-milliseconds integers (JS `Date.now()`), which
// fit comfortably in a JS number. `bigint({ mode: "number" })` keeps them as
// plain numbers on both the read and write side, preserving the contract the
// app and self-check rely on.
const nowMillis = sql`(extract(epoch from now()) * 1000)::bigint`;

// Application users. One row per Google account permitted to sign in.
//
// Identity is the internal `id` (a UUID we generate) — never Google's `sub`.
// `googleSub` stores the OAuth subject only as an immutable *lookup key* to
// recognize a returning login; it is not the primary key. It is nullable so a
// pre-existing / migrated row is adopted and stamped on its first sign-in.
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  googleSub: text("google_sub").unique(),
  name: text("name"),
  image: text("image"),
  createdAt: bigint("created_at", { mode: "number" })
    .notNull()
    .default(nowMillis),

  // --- Nightly Drive sync (per user) ---------------------------------------
  //
  // Opt-in: the nightly job imports for a user only while this is true. It is
  // the job's own kill switch as well as the user's — a token Google has
  // revoked, or one this app can no longer decrypt, flips it back to false so
  // the sync stops asking rather than failing every night forever.
  driveSyncEnabled: boolean("drive_sync_enabled").notNull().default(false),

  // The user's Drive refresh token, encrypted (see lib/crypto.ts). Null until
  // they connect, and null again the moment they disconnect — disconnecting
  // revokes the token at Google and clears it here, so a stored value always
  // means "we believe this still works".
  //
  // Never select this into anything the client can see, and never log it: it is
  // a live credential, not a record of one.
  driveRefreshTokenEnc: text("drive_refresh_token_enc"),

  // The Drive folder the user picked, via the Google Picker. Under the
  // `drive.file` scope this app can only see files the user has handed it, so
  // this id is not merely *where* to look — it is the whole extent of what this
  // app is allowed to read, chosen by the user at connect time.
  driveFolderId: text("drive_folder_id"),
  // What that folder is called, so the settings page can show the user which
  // folder they picked without spending a Drive call to look the name up.
  driveFolderName: text("drive_folder_name"),

  // When the nightly job last completed an import for this user. Null until the
  // first one lands.
  driveLastSyncedAt: bigint("drive_last_synced_at", { mode: "number" }),

  // Why the last attempt failed, in words meant for the user ("Reconnect your
  // Google Drive"), or null when the last attempt succeeded. This is the only
  // channel the unattended job has to reach the person it works for: nobody
  // reads the CronJob's logs, so a failure that is not written here is a
  // failure nobody learns about.
  driveLastError: text("drive_last_error"),

  // Opt-in: after a successful import, move every *other* Takeout zip in the
  // folder to Drive's trash, so the folder keeps exactly the newest export.
  //
  // Off by default and separate from the sync itself, because it is the only
  // thing this app does that writes to a user's Drive. Trash, never permanent
  // deletion — recoverable for 30 days, which is the difference between a
  // tidy-up and an automated way to lose the only copy of an export.
  driveTrashOldExports: boolean("drive_trash_old_exports")
    .notNull()
    .default(false),
});

// A named saved list imported from a Takeout export.
//
// `(user_id, name)` is unique: a list's identity *is* its name within an
// account, which is what makes re-import an upsert rather than a duplicate.
// The constraint is what lets that upsert be a single atomic statement, so two
// imports racing on the same list (an upload landing while the nightly Drive
// sync runs) converge on one row instead of forking into two.
export const lists = pgTable(
  "lists",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    // Where this import came from: a manual upload or the nightly Drive sync.
    source: text("source", { enum: ["upload", "drive"] }).notNull(),
    importedAt: bigint("imported_at", { mode: "number" })
      .notNull()
      .default(nowMillis),
    // Hidden lists are still imported and stored, just left out of the UI.
    hidden: boolean("hidden").notNull().default(false),
  },
  (t) => [unique("lists_user_id_name_unique").on(t.userId, t.name)],
);

// An individual saved place inside a list.
export const places = pgTable("places", {
  id: text("id").primaryKey(),
  listId: text("list_id")
    .notNull()
    .references(() => lists.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  title: text("title").notNull(),
  note: text("note"),
  mapsUrl: text("maps_url"),
  // Links to the enrichment cache. Nullable until a place has been resolved.
  cacheKey: text("cache_key").references(() => placeCache.key),
  // Google's id for this place, taken from the feature id in its Maps URL.
  // Stored rather than re-parsed so the join to `place_coords` is a plain
  // equality instead of a regex over a URL on every read. Nullable: a saved
  // shopping link has no place behind it and so has no id.
  cid: text("cid"),
  // Whether this saved entry is on a map at all. A Takeout "Saved" list holds
  // whatever the user starred, and a shopping item or a film is not somewhere
  // you can go.
  //
  // It lives here rather than in `place_cache` because it is a property of this
  // saved entry, not of a place: `isPlaceEntry` reads it off the entry's own
  // URL, offline, in microseconds, and it is true or false regardless of what
  // any other account saved. The cache is keyed by URL and shared by everyone,
  // which is the wrong grain — several unrelated entries can share one cache
  // row, and a fact about one of them is not a fact about the others.
  //
  // Recomputed on every import rather than remembered, which is exactly what
  // these rows already do: they are deleted and re-inserted wholesale, so a
  // derived column costs nothing to keep true and can never drift.
  notAPlace: boolean("not_a_place").notNull().default(false),
});

// Coordinates that are simply correct, because they were read off the place's
// own Google Maps page rather than guessed at from its name.
//
// This table is the reason `place_cache` can be wrong without mattering. It is
// authoritative and permanent: nothing in the import pipeline writes to it,
// nothing expires out of it, and a search result may never override it. It is
// filled only by `scripts/resolve-cids.py`, out of band, and afterwards a place
// in here costs no API call and cannot drift.
//
// The primary key is a generated id, not the CID, so that nothing is shut out
// of this table for lacking one. A place saved as bare coordinates has no CID
// at all — there is no Google place behind it to have an id — and those belong
// here as much as anything else.
//
// `cid` is the match key when there is one, and is the *right* match key: it
// identifies the place itself, where the surrounding URL also contains its name
// and changes when it is renamed, and the first half of the feature id is a
// geographic cell that can change if a business relocates. `mapsUrl` is the
// fallback match key, and the only one a coordinates-only place has.
export const placeCoords = pgTable("place_coords", {
  id: text("id").primaryKey(),
  // Google's id for the place. Null when the export saved raw coordinates
  // rather than a reference to a place. Unique where present — Postgres allows
  // any number of nulls in a unique index, which is exactly what is wanted.
  cid: text("cid").unique(),
  // The whole feature id it came from, kept for tracing a row back to a URL.
  ftid: text("ftid"),
  // The URL this was resolved from. Always present, so it is what identifies a
  // row that has no CID.
  mapsUrl: text("maps_url").notNull().unique(),
  lat: doublePrecision("lat").notNull(),
  lng: doublePrecision("lng").notNull(),
  // What the place was called when this was resolved. Not authoritative — the
  // point of this table is the coordinates — but it makes a row readable.
  title: text("title"),
  // Read off the same page as the coordinates, and true of the same place.
  //
  // These live here rather than only in `place_cache` because they are the same
  // kind of fact as the position: observed on the place's own map page, not
  // guessed at from a title. Keeping them in the cache alone would mean a
  // correction that survives nothing — clear the cache and the address reverts
  // to whichever business a text search had matched.
  //
  // Both are optional. The position comes out of the URL, but these come out of
  // the page, which changes far more often; a run that cannot find them leaves
  // them null rather than writing something worse than nothing.
  address: text("address"),
  // The category as the map page words it ("Bar"), normalised to the same
  // snake_case vocabulary the Places API uses ("bar") so one place does not
  // appear under two spellings of one category.
  category: text("category"),
  // "permanently" or "temporarily", when the map page said so; null when it did
  // not. A closed place is still a place and keeps its position — this only
  // records that going there would be a wasted trip, which is not otherwise
  // visible: nothing else about a closed listing looks any different.
  //
  // Read from the notice's wording, because Google marks it up with no
  // attribute and no stable class. The browser's locale is pinned for exactly
  // this reason.
  closed: text("closed", { enum: ["permanently", "temporarily"] }),
  // "browser" — read from the settled URL of the place's own Maps page.
  // "url"     — the export's own URL already stated the position.
  source: text("source", { enum: ["browser", "url"] }).notNull(),
  resolvedAt: bigint("resolved_at", { mode: "number" })
    .notNull()
    .default(nowMillis),
});

// Places waiting to have their real coordinates read off their own map page.
//
// Two things put rows here and they are the same work, so they share a queue: a
// user flagging a pin as wrong, and a queued import, which resolves nothing
// itself and instead enqueues every place it could not already answer for. The
// resolve run does not care which asked.
//
// This table *is* the queue. Nothing streams these to a worker: a row sits here
// until a run picks it up, which means the queue survives a restart, can be
// read before it is acted on, and can be re-run after a failure. A notification
// channel could only make that faster, never more reliable, so there isn't one.
//
// Unique on `maps_url` alone — not per user. The coordinates it produces go to
// `place_coords`, which is global because a place's position is a public fact,
// so two users asking for the same place is one piece of work. That also makes
// this a record of what still needs doing rather than an audit log: a place
// resolved and later flagged again re-opens its row.
export const placeQueue = pgTable(
  "place_queue",
  {
    id: text("id").primaryKey(),
    // What to resolve, identified the same way `place_coords` identifies a row
    // — by URL always, by CID when there is one. Deliberately not a reference
    // to `places.id`: those rows are deleted and recreated on every import, so
    // a queue entry pointing at one would not survive the night.
    mapsUrl: text("maps_url").notNull().unique(),
    cid: text("cid"),
    // Carried through so a queue waiting to be worked is readable without
    // joining back to a `places` row that may since have been replaced.
    title: text("title"),
    // Why it is here. Only affects how it is presented — the work is identical.
    //   flagged — a user said the pin is in the wrong place
    //   import  — a queued import had no answer for it and did not guess
    reason: text("reason", { enum: ["flagged", "import"] }).notNull(),
    // Who asked first. Null for an import that ran unattended.
    requestedBy: text("requested_by").references(() => users.id),
    // Optionally what the user thinks is wrong.
    note: text("note"),
    // pending   — waiting for a resolve run
    // done      — resolved; place_coords now has it
    // failed    — tried `MAX_RESOLVE_ATTEMPTS` times and never read a position
    // dismissed — closed by hand without resolving
    //
    // `failed` says nothing about the place. It means the page could not be
    // read — a consent wall, a slow load, a browser that crashed — which is a
    // fact about the runs, not about the world. An id Google has dropped is a
    // different thing entirely: that goes to `tombstone_cid`, and its queue row
    // is deleted rather than closed, because the tombstone is then the record.
    status: text("status", {
      enum: ["pending", "done", "failed", "dismissed"],
    })
      .notNull()
      .default("pending"),
    // How many resolve runs have opened this and come away with nothing.
    //
    // Without a count, "worth retrying" and "retried nine times and always
    // fails" are the same row, and a queue that cannot converge looks exactly
    // like a queue nobody has got to yet. It is what turns `failed` from a
    // guess into a decision.
    attempts: integer("attempts").notNull().default(0),
    // What went wrong the last time, in the scraper's own words. Kept because
    // the count says a row gave up and this says whether to believe it: "no
    // coordinates in settled URL" repeated three times is a real dead end,
    // three timeouts on the same evening are a bad network.
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(nowMillis),
    handledAt: bigint("handled_at", { mode: "number" }),
  },
  (t) => [index("place_queue_status_idx").on(t.status)],
);

// Feature ids Google will not resolve any more — a tombstone for each.
//
// A tombstone is a row whose whole purpose is to record an absence, so that
// later work can tell "we know there is nothing here" apart from "we have not
// looked yet". Without one the two are indistinguishable, and a queue full of
// places that can never resolve is retried forever.
//
// What is dead is the *id*, not necessarily the place. Opening the URL used to
// land on the place's own map page; it now settles on a blank map with the
// feature id stripped out of the URL — Google's way of saying it has no entry
// under that id. Some of these really are gone (a body shop, a house that was
// built over). Others plainly exist: Angkor Thom is still there, its saved id
// simply is not. So this records what cannot be resolved, and says nothing
// about what is or is not in the world.
//
// Named for what it is asked, not for what it describes: the only question this
// table answers is "is this CID dead?". It is not a `place_` table — it holds
// no place, and nothing joins to it for one. A place saved as bare coordinates
// can never be here, because it has no id to lose.
//
// So a lookup is by CID and only by CID. A search by title is a different
// route entirely — it never had the id and does not lose anything when the id
// dies — and is deliberately not gated on this.
export const tombstoneCid = pgTable("tombstone_cid", {
  id: text("id").primaryKey(),
  cid: text("cid").notNull().unique(),
  ftid: text("ftid"),
  // The URL that no longer resolves, kept so a row can be re-checked by hand.
  mapsUrl: text("maps_url").notNull(),
  // What the export called it. Often the only human-readable trace left.
  title: text("title"),
  // Where the browser ended up instead. The evidence for the row, so a future
  // reader can judge whether the conclusion still holds rather than trusting
  // it — Google's URL shapes are undocumented and do change.
  settledUrl: text("settled_url"),
  noticedAt: bigint("noticed_at", { mode: "number" })
    .notNull()
    .default(nowMillis),
});

// Enrichment cache keyed so that each real-world place costs at most one
// Places API call ever, even across re-imports. The cache is deliberately
// global rather than per-user: the data in it is public (name, address,
// coordinates, category — never a user's own note), so one account's lookup
// spares every other account the same call.
export const placeCache = pgTable("place_cache", {
  key: text("key").primaryKey(),
  placeId: text("place_id"),
  name: text("name"),
  address: text("address"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  // The Places API (New) primaryType, e.g. "thai_restaurant".
  category: text("category"),
  // JSON-encoded array of the full Places API types list.
  types: text("types"),
  // How this row was resolved, which decides how long it stays valid:
  //   ok          — resolved; kept indefinitely, no repeat call is ever needed
  //   not_found   — the API answered, and no such place exists; kept a long
  //                 time so a genuine miss is not re-billed on every import
  //   unavailable — the lookup itself failed (HTTP error, network, no API key
  //                 configured); kept only briefly so a transient outage does
  //                 not permanently blank out a place for every user
  status: text("status", { enum: ["ok", "not_found", "unavailable"] })
    .notNull()
    .default("ok"),
  // Where this row's coordinates came from. Provenance only — it does not
  // decide expiry, because nothing resolved ever expires. It answers "why is
  // this place here?" when a pin looks wrong.
  //
  //   coords  — mirrored from place_coords, which is authoritative
  //   url     — the export's own URL named the position
  //   search  — the Places API text search picked it, i.e. a guess
  resolver: text("resolver").notNull().default("search"),
  fetchedAt: bigint("fetched_at", { mode: "number" })
    .notNull()
    .default(nowMillis),
});

// A read-only public link to one user's map.
//
// The token IS the secret — anyone holding it reads the owner's non-hidden
// lists without signing in — so it is generated from a CSPRNG and is the
// primary key, never derived from the user id. One row per user (`user_id` is
// unique): issuing a new link replaces the old row, and that replacement is
// precisely what revokes the previous link.
export const shares = pgTable("shares", {
  token: text("token").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  createdAt: bigint("created_at", { mode: "number" })
    .notNull()
    .default(nowMillis),
});

export type User = typeof users.$inferSelect;
export type List = typeof lists.$inferSelect;
export type Place = typeof places.$inferSelect;
export type PlaceCache = typeof placeCache.$inferSelect;
export type PlaceCoords = typeof placeCoords.$inferSelect;
export type PlaceQueueEntry = typeof placeQueue.$inferSelect;
export type Share = typeof shares.$inferSelect;
