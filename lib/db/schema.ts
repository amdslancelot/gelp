import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
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
    // failed    — a run tried and could not resolve it
    // dismissed — closed by hand without resolving
    status: text("status", {
      enum: ["pending", "done", "failed", "dismissed"],
    })
      .notNull()
      .default("pending"),
    createdAt: bigint("created_at", { mode: "number" })
      .notNull()
      .default(nowMillis),
    handledAt: bigint("handled_at", { mode: "number" }),
  },
  (t) => [index("place_queue_status_idx").on(t.status)],
);

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
