// Write out the places whose pin was guessed by a name search, for the scraper
// to read the real position off each one's own page.
//
//   scripts/db-target.sh staging npx tsx scripts/dump-guessed.ts
//   python3 scripts/resolve-cids.py --input data/guessed.jsonl --details \
//       --out data/guessed-coords.jsonl
//   scripts/db-target.sh staging npx tsx scripts/load-resolved.ts \
//       data/guessed-coords.jsonl --apply
//
// Its own --out, for the same reason backfill-categories.ts has one: the
// default data/place-coords.jsonl is append-only across every run ever made and
// load-resolved.ts reads all of it, so pointing this run at it would re-write
// thousands of already-correct rows and bury the "what would change" summary
// that is the one thing worth reading before --apply.
//
// Who is in here
// --------------
// A place with a CID but no `place_coords` row. Its position came from the
// Places API text search — the amber "Guessed" badge — which pins by name and
// can land on a different business with a similar one. It also returns no
// category, which is why these same places sit in Uncategorised.
//
// Most of them exist because `places.cid` was null until `backfill-cids.ts`
// filled it: with no CID there was no way to ask for the place itself, so the
// guess was all there was. Filling the column is what made them askable; this
// is what asks.
//
// Why this is not `dump-queue.ts`
// -------------------------------
// The queue holds places the map cannot show. Every place here is on the map
// already — badly, but on it. `pending` would be the wrong word for them, the
// import counts those rows and reports them, and a UI announcing that 935
// places are unresolved when all 935 are pinned is a worse lie than the amber
// badge this is fixing. Same conclusion backfill-categories.ts reached, for the
// same reason. The queue is left alone.
//
// Safe to re-run: a place that gained a `place_coords` row drops out of the
// next dump, so an interrupted scrape resumes simply by dumping again. A place
// whose id Google has dropped drops out too, via `tombstone_cid` — otherwise
// every run would reopen the same dead pages to relearn the same nothing.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../lib/db/schema";
import { places, placeCoords, tombstoneCid } from "../lib/db/schema";

async function main() {
  const args = process.argv.slice(2);
  const out = resolve(
    args.find((a) => !a.startsWith("--")) ?? "data/guessed.jsonl",
  );
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;
  // Dead ids are skipped by default; this dumps them anyway. A flag rather
  // than the default for the reason dump-queue.ts gives its --retry-failed:
  // the tombstone was written because Google had no entry under that id, and
  // only something outside the loop can know that has changed. That something
  // is a person. There is no delete path for a tombstone, so without this
  // there would be no way back at all.
  const includeTombstoned = args.includes("--include-tombstoned");

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
    // Distinct by URL, not by place: `place_coords` is keyed on the CID and
    // shared by everyone, so several saved entries pointing at one business
    // need exactly one page opened between them. The scraper dedupes its input
    // too, but a work list that says 935 when 935 pages will be opened is the
    // one a person can plan a slow run around.
    const rows = await db
      .selectDistinctOn([places.mapsUrl], {
        mapsUrl: places.mapsUrl,
        title: places.title,
      })
      .from(places)
      .where(
        and(
          isNotNull(places.cid),
          isNotNull(places.mapsUrl),
          eq(places.notAPlace, false),
          sql`not exists (select 1 from ${placeCoords} pc where pc.cid = ${places.cid})`,
          // A CID Google will not resolve any more. Opening its URL lands on
          // a blank map, so dumping it again spends a page load to relearn
          // what `tombstone_cid` was created to remember — and it would do so
          // on every run, forever, because nothing about it can change.
          //
          // What is dead is the id, not the place: Angkor Thom is still
          // there, its saved id simply is not. So this drops it from the work
          // list and says nothing about whether it is still in the world.
          includeTombstoned
            ? undefined
            : sql`not exists (select 1 from ${tombstoneCid} tc where tc.cid = ${places.cid})`,
        ),
      )
      // selectDistinctOn requires the distinct column to lead the ordering;
      // title after it only makes the file's order stable between runs, so a
      // run cut short resumes at a predictable place.
      .orderBy(places.mapsUrl, places.title);

    const work = limit > 0 ? rows.slice(0, limit) : rows;

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      work
        .map((r) =>
          JSON.stringify({
            key: r.mapsUrl,
            title: r.title ?? "",
            reason: "guessed",
          }),
        )
        .join("\n") + (work.length > 0 ? "\n" : ""),
      "utf8",
    );

    console.log(`${work.length} guessed places need a real position -> ${out}`);
    if (limit > 0 && rows.length > work.length) {
      console.log(`  ${rows.length - work.length} left for a later run`);
    }

    // Say what was left out. A work list that silently drops rows reads as
    // "this is everything", and the number of dead ids is exactly the sort of
    // thing worth noticing if it starts growing.
    if (!includeTombstoned) {
      const [dead] = await db
        .select({ count: sql<number>`count(distinct ${places.mapsUrl})::int` })
        .from(places)
        .where(
          and(
            isNotNull(places.cid),
            isNotNull(places.mapsUrl),
            eq(places.notAPlace, false),
            sql`not exists (select 1 from ${placeCoords} pc where pc.cid = ${places.cid})`,
            sql`exists (select 1 from ${tombstoneCid} tc where tc.cid = ${places.cid})`,
          ),
        );
      if ((dead?.count ?? 0) > 0) {
        console.log(
          `  ${dead!.count} skipped: Google no longer has the id. ` +
            `Pass --include-tombstoned to try them anyway.`,
        );
      }
    }
    if (work.length > 0) {
      console.log(
        `\nNext: python3 scripts/resolve-cids.py --input ${out} --details ` +
          `--out data/guessed-coords.jsonl`,
      );
      console.log(
        "This opens one Google Maps page per place. It is slow on purpose.",
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
