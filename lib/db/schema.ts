import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
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
export type Share = typeof shares.$inferSelect;
