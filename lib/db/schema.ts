import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  pgTable,
  text,
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
export const lists = pgTable("lists", {
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
});

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
// Places API call ever, even across re-imports.
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
  fetchedAt: bigint("fetched_at", { mode: "number" })
    .notNull()
    .default(nowMillis),
});

export type User = typeof users.$inferSelect;
export type List = typeof lists.$inferSelect;
export type Place = typeof places.$inferSelect;
export type PlaceCache = typeof placeCache.$inferSelect;
