// Fill in `places.cid` for rows whose Maps URL names a CID but whose column is
// null.
//
//   scripts/db-target.sh staging npx tsx scripts/backfill-cids.ts
//   scripts/db-target.sh staging npx tsx scripts/backfill-cids.ts --apply
//
// Dry run by default: it prints what would change and writes nothing.
//
// What is broken
// --------------
// `places.cid` is derived from `maps_url` by `cidFromMapsUrl`, and it is
// computed once, at import (lib/import.ts). It is never recomputed afterwards.
// So when that function learned a URL shape it had not previously understood —
// the `http://maps.google.com/?cid=<decimal>` form a Saved Places export
// writes — every row already in the table kept the null it was imported with.
// The parser is right and has been for a while; the rows are simply stale.
//
// Why the null matters
// --------------------
// The CID is the join key to `place_coords`, the authoritative table. Without
// one, `dump-queue.ts` cannot hand the place to `resolve-cids.py`, so nothing
// ever reads the coordinates off the place's own Maps page. The import falls
// back to a Places API text search, which pins by name — that is what the
// amber "Guessed" badge on a row means — and a text search returns no category
// either, so the same places also sit in Uncategorised.
//
// So this is not a cosmetic column. Filling it is what makes those places
// eligible for the resolve path at all.
//
// Why a plain UPDATE and not a re-import
// --------------------------------------
// Re-importing would recompute the column, but it deletes and re-inserts the
// place rows wholesale, which throws away their ids — and a share link, a
// queue entry, and anything else pointing at a place points at its id. This
// touches one derived column and nothing else.
//
// Safe to re-run: a row that already has a CID is never considered, so a second
// run finds nothing to do.

import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNull, isNotNull, sql, inArray } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../lib/db/schema";
import { places, placeCoords } from "../lib/db/schema";
import { cidFromMapsUrl } from "../lib/takeout";

async function main() {
  const apply = process.argv.includes("--apply");

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set — run this through scripts/db-target.sh",
    );
    process.exit(1);
  }

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  try {
    // `not_a_place` rows are excluded: a saved shopping link or a film is not
    // somewhere you can go, so a CID on it would only make it eligible for a
    // resolve that has nothing to find.
    const rows = await db
      .select({ id: places.id, title: places.title, mapsUrl: places.mapsUrl })
      .from(places)
      .where(
        and(
          isNull(places.cid),
          isNotNull(places.mapsUrl),
          eq(places.notAPlace, false),
        ),
      );

    const work: { id: string; title: string; cid: string }[] = [];
    for (const r of rows) {
      const cid = cidFromMapsUrl(r.mapsUrl ?? undefined);
      if (cid) work.push({ id: r.id, title: r.title, cid });
    }

    console.log(`${rows.length} places have no cid`);
    console.log(`  ${work.length} of them have one in their maps_url`);
    console.log(
      `  ${rows.length - work.length} genuinely have none (bare coords, or no place behind the link)`,
    );

    if (work.length === 0) {
      console.log("\nNothing to do.");
      return;
    }

    // How many land on a CID that has already been scraped for some other
    // place. Note these are not a win the UI will show: `load-resolved.ts`
    // writes `place_cache.resolver = 'coords'` at the same time it writes
    // `place_coords`, and the read path reads the badge off the cache row —
    // which is shared by URL — so those places were already displaying as
    // resolved before this ran. Filling the column makes the join true as well
    // as the cache, which is what stops the two disagreeing.
    //
    // The rest are the actual point of this script: they have no `place_coords`
    // row at all, and without a CID nothing could ever go and fetch them one.
    const distinct = [...new Set(work.map((w) => w.cid))];
    const known = new Set(
      (
        await db
          .select({ cid: placeCoords.cid })
          .from(placeCoords)
          .where(inArray(placeCoords.cid, distinct))
      )
        .map((r) => r.cid)
        .filter((c): c is string => c !== null),
    );
    const hit = work.filter((w) => known.has(w.cid)).length;

    console.log(
      `\n${distinct.length} distinct cids; ${hit} share one already scraped (already displaying as resolved — no visible change)`,
    );
    console.log(
      `  ${work.length - hit} have no coordinates scraped at all — this is what the fill unlocks`,
    );

    console.log("\nSample of what would change:");
    for (const w of work.slice(0, 10)) {
      console.log(`  ${w.cid}  ${w.title}`);
    }
    if (work.length > 10) console.log(`  … and ${work.length - 10} more`);

    if (!apply) {
      console.log("\nDry run. Re-run with --apply to write.");
      return;
    }

    // One statement, not one per row: 973 round trips to set a derived column
    // is a transaction held open for no reason. The values list is built from
    // the ids just read, so it can only touch rows this run examined.
    const values = sql.join(
      work.map((w) => sql`(${w.id}, ${w.cid})`),
      sql`, `,
    );
    const res = await db.execute(sql`
      update ${places} set cid = v.cid
      from (values ${values}) as v(id, cid)
      where ${places.id} = v.id and ${places.cid} is null
    `);
    console.log(`\nUpdated ${res.rowCount ?? work.length} rows.`);
    // Deliberately not "next: queue:resolve". That reads `place_queue`, and
    // these places are not in it and should not be put there: `pending` means
    // "the map cannot show this place", and every one of these is on the map
    // already — pinned by a name search, which is what makes it worth
    // re-reading, but pinned. Same argument as backfill-categories.ts. They
    // need their own dump.
    console.log(
      "These places now have a CID but no scraped coordinates. They are not in " +
        "place_queue and do not belong there — they need their own dump into " +
        "resolve-cids.py.",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
