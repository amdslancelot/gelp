ALTER TABLE "places" ADD COLUMN "not_a_place" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Backfill, so the flag is right before the next import rather than after it.
--
-- The predicate is `isPlaceEntry` (lib/takeout.ts) written out in SQL: an entry
-- is a place when its URL yields a feature id, a `?cid=`, or coordinates in any
-- of the shapes Maps writes them. Anything else the user starred — a shopping
-- item, a film — is not somewhere on a map.
--
-- Duplicating that logic here is deliberate and one-off: every later import
-- recomputes the column from the TypeScript version, so this statement decides
-- nothing beyond the rows that exist right now.
UPDATE "places" SET "not_a_place" = true
WHERE "maps_url" IS NOT NULL
  AND "maps_url" !~* '!1s0x[0-9a-f]+:0x[0-9a-f]+'
  AND "maps_url" !~ '[?&]cid=[0-9]+'
  AND "maps_url" !~ '/maps/(search|place|dir)/-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?'
  AND "maps_url" !~ '@-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?'
  AND "maps_url" !~ '[?&](q|ll|center|daddr)=-?[0-9]+(\.[0-9]+)?,-?[0-9]+(\.[0-9]+)?'
  AND "maps_url" !~ '!3d-?[0-9]+(\.[0-9]+)?!4d-?[0-9]+(\.[0-9]+)?';--> statement-breakpoint
-- Clear the cached search results that were written for those entries.
--
-- Nothing reads them any more — the read path answers `not_a_place` before it
-- looks at the cache — but they are still wrong, and `place_cache` is global,
-- so they are wrong for every account and for anyone reading the table
-- directly. A count of guessed positions should not include coordinates for a
-- car part.
--
-- Scoped through the flag set above rather than by repeating the URL predicate,
-- so the two statements cannot disagree about what a non-place is. What is
-- written here is exactly what `runImport` writes for a non-place, so the next
-- import agrees with it instead of overwriting it back.
UPDATE "place_cache" SET
  "place_id" = NULL,
  "address" = NULL,
  "lat" = NULL,
  "lng" = NULL,
  "category" = NULL,
  "types" = NULL,
  "status" = 'not_found',
  "resolver" = 'not_a_place',
  "fetched_at" = (extract(epoch from now()) * 1000)::bigint
WHERE "key" IN (
  SELECT "cache_key" FROM "places"
  WHERE "not_a_place" AND "cache_key" IS NOT NULL
);
