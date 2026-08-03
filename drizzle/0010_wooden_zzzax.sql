-- Drop the queue entries that a tombstone has already answered.
--
-- `place_queue` is a record of work still to do. A row whose CID is in
-- `tombstone_cid` is not work — no resolve run can open a page that Google has
-- no entry for — and the tombstone is the better record of that anyway: it
-- carries the settled URL, which is the evidence, where the queue row carries
-- only the verdict.
--
-- Keeping both is what makes them able to disagree. `tombstone_cid` has no
-- delete path in the app, but a tombstone cleared by hand would leave this row
-- behind, and it would go on blocking a re-queue through the unique constraint
-- on `maps_url` — silently, since `enqueuePlaces` conflicts and returns zero
-- with nothing to say why.
--
-- Matched on `maps_url`, not `cid`: these rows were backfilled with a null
-- `cid` column, and the URL is what both tables certainly share.
--
-- Deliberately narrow — only rows a tombstone covers. A `pending` row is
-- outstanding work and is left alone.
DELETE FROM "place_queue" q
USING "tombstone_cid" t
WHERE q."maps_url" = t."maps_url"
  AND q."status" <> 'pending';
