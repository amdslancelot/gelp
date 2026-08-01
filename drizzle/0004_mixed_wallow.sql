CREATE TABLE "place_coords" (
	"id" text PRIMARY KEY NOT NULL,
	"cid" text,
	"ftid" text,
	"maps_url" text NOT NULL,
	"lat" double precision NOT NULL,
	"lng" double precision NOT NULL,
	"title" text,
	"source" text NOT NULL,
	"resolved_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	CONSTRAINT "place_coords_cid_unique" UNIQUE("cid"),
	CONSTRAINT "place_coords_maps_url_unique" UNIQUE("maps_url")
);
--> statement-breakpoint
ALTER TABLE "place_cache" ADD COLUMN "resolver" text DEFAULT 'search' NOT NULL;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "cid" text;--> statement-breakpoint
-- Backfill the CID for places already imported, so they join to place_coords
-- without waiting for the next import to recompute it. Only the feature-id form
-- is handled here; the `?cid=<decimal>` form needs 64-bit unsigned arithmetic
-- Postgres has no clean type for, and the import recomputes both anyway.
UPDATE "places"
SET "cid" = '0x' || lpad(lower(substring("maps_url" from '!1s0x[0-9a-fA-F]+:0x([0-9a-fA-F]+)')), 16, '0')
WHERE "maps_url" ~ '!1s0x[0-9a-fA-F]+:0x[0-9a-fA-F]+';--> statement-breakpoint
-- A row claiming 'ok' with no coordinates is not an answer, and rows no longer
-- expire by age, so left alone it would keep a place unlocated forever. Mark
-- them 'unavailable', the one status that is still retried.
UPDATE "place_cache" SET "status" = 'unavailable'
WHERE "status" = 'ok' AND "lat" IS NULL;
