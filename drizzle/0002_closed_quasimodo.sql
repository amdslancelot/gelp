ALTER TABLE "place_cache" ADD COLUMN "status" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
-- Existing rows default to 'ok', which is right for every resolved row. Rows
-- that never resolved are marked 'unavailable' rather than 'not_found':
-- until now a failed lookup was cached permanently, so these rows may be
-- failures rather than genuine misses and deserve one retry. A place that
-- really does not exist costs one call, then settles as 'not_found'.
UPDATE "place_cache" SET "status" = 'unavailable' WHERE "lat" IS NULL AND "place_id" IS NULL;--> statement-breakpoint
-- Collapse any duplicate (user_id, name) lists left behind by the old
-- select-then-insert upsert, otherwise the constraint below cannot be added.
-- The most recently imported row wins; the losers' places are re-pointed at it
-- first, so nothing is lost to the ON DELETE CASCADE.
UPDATE "places" SET "list_id" = d."keeper_id"
FROM (
	SELECT "id", first_value("id") OVER (
		PARTITION BY "user_id", "name" ORDER BY "imported_at" DESC, "id"
	) AS "keeper_id" FROM "lists"
) d
WHERE "places"."list_id" = d."id" AND d."id" <> d."keeper_id";--> statement-breakpoint
DELETE FROM "lists" USING (
	SELECT "id", first_value("id") OVER (
		PARTITION BY "user_id", "name" ORDER BY "imported_at" DESC, "id"
	) AS "keeper_id" FROM "lists"
) d
WHERE "lists"."id" = d."id" AND d."id" <> d."keeper_id";--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_user_id_name_unique" UNIQUE("user_id","name");
