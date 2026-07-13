import { sql } from "drizzle-orm";
import {
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// Application users. One row per Google account permitted to sign in.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  createdAt: integer("created_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// A named saved list imported from a Takeout export.
export const lists = sqliteTable("lists", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  // Where this import came from: a manual upload or the nightly Drive sync.
  source: text("source", { enum: ["upload", "drive"] }).notNull(),
  importedAt: integer("imported_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

// An individual saved place inside a list.
export const places = sqliteTable("places", {
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
export const placeCache = sqliteTable("place_cache", {
  key: text("key").primaryKey(),
  placeId: text("place_id"),
  name: text("name"),
  address: text("address"),
  lat: real("lat"),
  lng: real("lng"),
  // The Places API (New) primaryType, e.g. "thai_restaurant".
  category: text("category"),
  // JSON-encoded array of the full Places API types list.
  types: text("types"),
  fetchedAt: integer("fetched_at")
    .notNull()
    .default(sql`(unixepoch() * 1000)`),
});

export type User = typeof users.$inferSelect;
export type List = typeof lists.$inferSelect;
export type Place = typeof places.$inferSelect;
export type PlaceCache = typeof placeCache.$inferSelect;
