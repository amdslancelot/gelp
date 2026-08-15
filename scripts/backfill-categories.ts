// Write out the places that have a position but no category, for the scraper
// to read the category off each one's own page.
//
//   scripts/db-target.sh staging npx tsx scripts/backfill-categories.ts
//   python3 scripts/resolve-cids.py --input data/backfill.jsonl --details \
//       --out data/backfill-coords.jsonl
//   scripts/db-target.sh staging npx tsx scripts/load-resolved.ts \
//       data/backfill-coords.jsonl --apply
//
// Its own --out, not the default data/place-coords.jsonl. That file is
// append-only across every run ever made, and load-resolved.ts reads all of it:
// pointing this run at it would re-write thousands of rows that are already
// right, and drown the "what would change" summary — the one thing worth
// reading before --apply — in them.
//
// Why this is not `dump-queue.ts`
// -------------------------------
// The queue holds places with no coordinates yet. These places have theirs —
// they were resolved before the run learned to read a category off the page
// (2026-08-01), so they are finished as far as the queue is concerned and will
// never appear in a dump of it. They are missing a field, not a position.
//
// Writing them into place_queue to reuse that path was the alternative, and it
// is wrong: `pending` means "the map cannot show this place", the import counts
// those rows and reports them, and a UI that says 3729 places are unresolved
// when every one of them is on the map is a worse lie than the empty chip this
// is fixing. So the work list is built here and the queue is left alone.
//
// The output is the same JSON Lines shape the scraper already reads, so nothing
// downstream needs to know this run is a backfill: resolve-cids.py takes it
// with --input, and load-resolved.ts writes it back with the `coalesce` that
// keeps every value already known. Re-running the whole thing is therefore
// safe — a place that gained a category simply drops out of the next dump.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, isNotNull, isNull, or, eq, sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../lib/db/schema";
import { placeCoords } from "../lib/db/schema";

async function main() {
  const args = process.argv.slice(2);
  const out = resolve(
    args.find((a) => !a.startsWith("--")) ?? "data/backfill.jsonl",
  );
  const limitArg = args.find((a) => a.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : 0;

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
    // Empty string as well as null: place_cache stores the Places API's absent
    // `primaryType` as "", and the filter chips treat both the same way, so a
    // backfill that only looked for null would leave a bucket of places that
    // are visibly uncategorised in the UI but invisible to this query.
    //
    // A place that has closed is skipped. Google puts the closure notice where
    // the category button would be, so its page has no category to read — the
    // scrape would spend a page load to learn nothing, every run, forever.
    //
    // Same argument for a URL with no feature id in it. A handful of rows were
    // resolved from a bare `/maps/search/<lat>,<lng>`, which opens a map at a
    // point rather than a place: there is no panel on that page, so there is no
    // category on it either, and no run will ever change that.
    const rows = await db
      .select({
        mapsUrl: placeCoords.mapsUrl,
        title: placeCoords.title,
      })
      .from(placeCoords)
      .where(
        and(
          or(isNull(placeCoords.category), eq(placeCoords.category, "")),
          isNull(placeCoords.closed),
          sql`${placeCoords.mapsUrl} like '%!1s0x%'`,
        ),
      )
      // Oldest first, matching dump-queue: if a run is cut short, the next one
      // resumes at a predictable place rather than reshuffling the remainder.
      .orderBy(placeCoords.resolvedAt);

    const work = limit > 0 ? rows.slice(0, limit) : rows;

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      work
        .map((r) =>
          JSON.stringify({
            key: r.mapsUrl,
            title: r.title ?? "",
            reason: "backfill",
          }),
        )
        .join("\n") + (work.length > 0 ? "\n" : ""),
      "utf8",
    );

    const [total] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(placeCoords);
    const closed = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(placeCoords)
      .where(
        and(
          or(isNull(placeCoords.category), eq(placeCoords.category, "")),
          isNotNull(placeCoords.closed),
        ),
      );

    console.log(`${work.length} places need a category -> ${out}`);
    console.log(`  out of ${total?.count ?? 0} with coordinates`);
    if ((closed[0]?.count ?? 0) > 0) {
      console.log(
        `  ${closed[0]!.count} more are closed and have no category to read`,
      );
    }
    if (limit > 0 && rows.length > work.length) {
      console.log(`  ${rows.length - work.length} left for a later run`);
    }
    if (work.length > 0) {
      console.log(
        `\nNext: python3 scripts/resolve-cids.py --input ${out} --details ` +
          `--out data/backfill-coords.jsonl`,
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
