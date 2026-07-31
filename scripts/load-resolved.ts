// Load coordinates produced by `scripts/resolve-cids.py` into place_coords.
//
// place_coords is authoritative: its rows were read off each place's own Google
// Maps page rather than guessed at from its name, so they are simply correct.
// Nothing in the import pipeline writes there, nothing expires out of it, and
// both the import and the read path consult it ahead of place_cache. A place
// loaded here is settled permanently and costs no API call ever again.
//
// Keyed on the CID — the half of the feature id that identifies the place
// itself, so a business that is renamed or relocated keeps its row.
//
//   npm run db:up
//   DATABASE_URL=... npx tsx scripts/load-resolved.ts resolved.jsonl --dry-run
//   DATABASE_URL=... npx tsx scripts/load-resolved.ts resolved.jsonl
//
// It is a dry run unless told otherwise, printing what it would change.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "../lib/db/schema";
import { placeCache, placeCoords, placeQueue } from "../lib/db/schema";
import { cidFromMapsUrl, ftidFromMapsUrl } from "../lib/takeout";
import { haversineMeters } from "../lib/geo";
import { RESOLVER_COORDS } from "../lib/import";

// One line of the scraper's output.
interface Line {
  key: string; // the place's Maps URL
  title: string;
  lat?: number;
  lng?: number;
  source?: string;
  resolved_at?: number;
  error?: string;
}

// One row ready for place_coords.
interface Row {
  // Null for a place saved as bare coordinates: there is no Google place behind
  // it to have an id, and `mapsUrl` identifies it instead.
  cid: string | null;
  ftid: string | null;
  mapsUrl: string;
  title: string;
  lat: number;
  lng: number;
  source: "browser" | "url";
  resolvedAt: number;
}

function parse(path: string): { rows: Row[]; skipped: number } {
  // Keyed by whatever identifies the row, so a place resolved twice — the bulk
  // run and again after a flag — collapses to one row, the later one winning.
  const byIdentity = new Map<string, Row>();
  let skipped = 0;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let row: Line;
    try {
      row = JSON.parse(trimmed) as Line;
    } catch {
      continue; // A half-written final line from an interrupted run.
    }

    if (
      typeof row.key !== "string" ||
      typeof row.lat !== "number" ||
      typeof row.lng !== "number" ||
      Math.abs(row.lat) > 90 ||
      Math.abs(row.lng) > 180
    ) {
      continue; // An error line, or a place that could not be resolved.
    }

    // A place saved as bare coordinates has no CID — there is no Google place
    // behind it — so it is identified by its URL instead. It belongs here all
    // the same; nothing is excluded for lacking an id.
    const cid = cidFromMapsUrl(row.key) ?? null;
    byIdentity.set(cid ?? row.key, {
      cid,
      ftid: ftidFromMapsUrl(row.key) ?? null,
      mapsUrl: row.key,
      title: row.title,
      lat: row.lat,
      lng: row.lng,
      source: row.source === "url" ? "url" : "browser",
      resolvedAt: row.resolved_at ?? Date.now(),
    });
  }

  return { rows: [...byIdentity.values()], skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const path = args.find((a) => !a.startsWith("--"));
  if (!path) {
    console.error("usage: load-resolved.ts <resolved.jsonl> [--apply]");
    process.exit(1);
  }

  const { rows, skipped } = parse(resolve(path));
  console.log(`${rows.length} resolved coordinates in ${path}`);
  if (skipped > 0) {
    console.log(`${skipped} skipped: no place behind the URL`);
  }
  if (rows.length === 0) return;

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool, { schema });

  try {
    // Where the search had put these places, so the summary reports what
    // actually changes rather than how many lines the file has. The comparison
    // is against place_cache because that is what the map has been showing.
    const keys = rows.map((r) => r.mapsUrl);
    const before = new Map<string, { lat: number | null; lng: number | null }>();
    for (let i = 0; i < keys.length; i += 500) {
      const found = await db
        .select()
        .from(placeCache)
        .where(inArray(placeCache.key, keys.slice(i, i + 500)));
      for (const row of found) before.set(row.key, { lat: row.lat, lng: row.lng });
    }

    let added = 0;
    let moved = 0;
    let same = 0;
    const examples: Array<[number, string]> = [];
    for (const row of rows) {
      const had = before.get(row.mapsUrl);
      if (!had || had.lat === null || had.lng === null) {
        added += 1;
        continue;
      }
      // The same haversine the import uses to reject an out-of-region
      // candidate. A flat approximation is fine at the half-kilometre mark this
      // is thresholded on, but these errors run to the other side of the world,
      // where it reports distances longer than the planet.
      const km =
        haversineMeters({ lat: had.lat, lng: had.lng }, row) / 1000;
      if (km < 0.5) same += 1;
      else {
        moved += 1;
        examples.push([km, row.title]);
      }
    }

    console.log(`  ${same} already correct (within 500 m)`);
    console.log(`  ${added} had no coordinates at all`);
    console.log(`  ${moved} were in the wrong place and will move`);
    if (examples.length > 0) {
      console.log("\nfurthest corrections:");
      examples.sort((a, b) => b[0] - a[0]);
      for (const [km, title] of examples.slice(0, 20)) {
        console.log(`  ${km.toFixed(0).padStart(6)} km  ${title}`);
      }
    }

    if (!apply) {
      console.log("\ndry run — nothing written. Pass --apply to write.");
      return;
    }

    // Two batches with different conflict targets, because a row's identity is
    // its CID when it has one and its URL when it does not. Matching on the CID
    // is what lets a place that was renamed between exports — and so arrives
    // under a different URL — keep the coordinates already resolved for it.
    let written = 0;
    for (const withCid of [true, false]) {
      const subset = rows.filter((r) => Boolean(r.cid) === withCid);
      for (let i = 0; i < subset.length; i += 500) {
        const batch = subset.slice(i, i + 500).map((r) => ({
          id: randomUUID(),
          cid: r.cid,
          ftid: r.ftid,
          mapsUrl: r.mapsUrl,
          lat: r.lat,
          lng: r.lng,
          title: r.title,
          source: r.source,
          resolvedAt: r.resolvedAt,
        }));
        const set = {
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          title: sql`excluded.title`,
          ftid: sql`excluded.ftid`,
          mapsUrl: sql`excluded.maps_url`,
          source: sql`excluded.source`,
          resolvedAt: sql`excluded.resolved_at`,
        };
        const done = await db
          .insert(placeCoords)
          .values(batch)
          .onConflictDoUpdate({
            target: withCid ? placeCoords.cid : placeCoords.mapsUrl,
            set,
          })
          .returning({ id: placeCoords.id });
        written += done.length;
      }
    }

    console.log(`\nwrote ${written} rows to place_coords`);
    console.log("These are authoritative: no expiry, no API call, ever.");

    // Correct the cache to match. Reads already prefer `place_coords`, so the
    // map is right without this — but leaving a known-wrong row sitting in the
    // cache means anything reading only the cache stays wrong, and the next
    // import would mirror the correct value anyway. Doing it here just makes
    // the two agree from the moment the coordinates are known.
    //
    // An update, never an insert: a place that has no cache row does not need
    // one, because nothing is looking there for it.
    //
    // Matched on the CID rather than on the URL alone, because the same place
    // turns up in an export under more than one URL — `!1s0x8085…:0xe090…` and
    // a bare `!1s0x0:0xe090…` are the same bar. Rows are collapsed by CID
    // before being written above, so correcting only the URL that survived
    // would leave the other spelling of that place stale in the cache.
    //
    // The index is built from the cache's own keys, not from the file, so a URL
    // that only an older export ever used is corrected too. Reading every key
    // to do it is affordable: the cache has one row per place, not per saving.
    const keysByCid = new Map<string, string[]>();
    for (const { key } of await db
      .select({ key: placeCache.key })
      .from(placeCache)) {
      const cid = cidFromMapsUrl(key);
      if (!cid) continue;
      const seen = keysByCid.get(cid);
      if (seen) seen.push(key);
      else keysByCid.set(cid, [key]);
    }

    let corrected = 0;
    for (const row of rows) {
      // Falling back to the URL covers a place saved as bare coordinates, which
      // has no CID to match on.
      const keys = (row.cid && keysByCid.get(row.cid)) || [row.mapsUrl];
      const done = await db
        .update(placeCache)
        .set({
          lat: row.lat,
          lng: row.lng,
          status: "ok",
          resolver: RESOLVER_COORDS,
          fetchedAt: Date.now(),
        })
        .where(inArray(placeCache.key, keys))
        .returning({ key: placeCache.key });
      corrected += done.length;
    }
    console.log(`corrected ${corrected} cached rows to match`);

    // Close the queue entries these coordinates answer. Done last and scoped to
    // what was actually written, so a place whose lookup failed stays pending
    // and is picked up by the next run rather than being quietly dropped.
    let closed = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const done = await db
        .update(placeQueue)
        .set({ status: "done", handledAt: Date.now() })
        .where(
          and(
            eq(placeQueue.status, "pending"),
            inArray(
              placeQueue.mapsUrl,
              rows.slice(i, i + 500).map((r) => r.mapsUrl),
            ),
          ),
        )
        .returning({ id: placeQueue.id });
      closed += done.length;
    }
    if (closed > 0) console.log(`closed ${closed} queue entries`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
