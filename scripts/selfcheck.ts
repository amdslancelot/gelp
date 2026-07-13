import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import { users } from "../lib/db/schema";
import { parseTakeoutZip } from "../lib/takeout";
import { runImport } from "../lib/import";
import type { PlaceResult, PlacesClient } from "../lib/places";

// A tiny assertion helper that records failures rather than throwing, so the
// script can print a complete summary before exiting.
const failures: string[] = [];
function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  PASS  ${message}`);
  } else {
    console.log(`  FAIL  ${message}`);
    failures.push(message);
  }
}

// A stub Places client that returns canned data and counts its calls, proving
// the pipeline never touches the network.
class StubPlacesClient implements PlacesClient {
  calls = 0;
  async searchText(query: string): Promise<PlaceResult | null> {
    this.calls += 1;
    return {
      placeId: `stub-${this.calls}`,
      name: query,
      address: "123 Test St",
      lat: 40 + this.calls * 0.01,
      lng: -70 - this.calls * 0.01,
      category: "thai_restaurant",
      types: ["thai_restaurant", "restaurant"],
    };
  }
}

// Build the fixture Takeout zip programmatically, overwriting any prior copy.
function buildFixture(): Buffer {
  const zip = new AdmZip();

  // A list whose second row exercises quoting: an embedded comma, a newline in
  // the note, and an escaped quote.
  const favorites = [
    "Title,Note,URL",
    "Blue Bottle,Great coffee,https://maps.google.com/?cid=1",
    `"Joe's, Diner","Line one\nLine two ""quoted""",https://maps.google.com/?cid=2`,
    "Corner Bakery,,https://maps.google.com/?cid=3",
  ].join("\n");

  const wantToGo = [
    "Title,Note,URL",
    "Museum of Math,Fun,https://maps.google.com/?cid=4",
    "Skyline Park,,https://maps.google.com/?cid=5",
  ].join("\n");

  // Two GeoJSON features that carry coordinates, so they cost zero API calls.
  const savedPlaces = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [-73.9857, 40.7484] },
        properties: {
          google_maps_url: "https://maps.google.com/?cid=100",
          location: {
            name: "Empire State Building",
            address: "20 W 34th St, New York",
          },
        },
      },
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [2.2945, 48.8584] },
        properties: {
          google_maps_url: "https://maps.google.com/?cid=101",
          location: { name: "Eiffel Tower", address: "Champ de Mars, Paris" },
        },
      },
    ],
  };

  zip.addFile(
    "Takeout/Saved/Favorite places.csv",
    Buffer.from(favorites, "utf8"),
  );
  zip.addFile("Takeout/Saved/Want to go.csv", Buffer.from(wantToGo, "utf8"));
  zip.addFile(
    "Takeout/Saved/Saved Places.json",
    Buffer.from(JSON.stringify(savedPlaces), "utf8"),
  );

  const buf = zip.toBuffer();

  const dir = resolve("test/fixtures");
  mkdirSync(dir, { recursive: true });
  zip.writeZip(join(dir, "takeout-sample.zip"));

  return buf;
}

function main() {
  console.log("Gelp offline self-check\n");

  // 1. Build the fixture.
  const buf = buildFixture();

  // 2. Parse and assert structure.
  console.log("Parsing fixture:");
  const parsed = parseTakeoutZip(buf);
  const byName = Object.fromEntries(parsed.lists.map((l) => [l.name, l]));
  assert(parsed.lists.length === 3, "three lists parsed");
  assert(
    byName["Favorite places"]?.places.length === 3,
    "Favorite places has 3 places",
  );
  assert(byName["Want to go"]?.places.length === 2, "Want to go has 2 places");
  assert(
    byName["Saved Places"]?.places.length === 2,
    "Saved Places has 2 places",
  );

  const tricky = byName["Favorite places"]?.places[1];
  assert(tricky?.title === "Joe's, Diner", "quoted title round-trips");
  assert(
    tricky?.note === 'Line one\nLine two "quoted"',
    "quoted note with newline and escaped quotes round-trips",
  );

  const savedFeature = byName["Saved Places"]?.places[0];
  assert(
    savedFeature?.lat === 40.7484 && savedFeature?.lng === -73.9857,
    "Saved Places coordinates carried through",
  );

  // 3. Fresh import into a temp database.
  console.log("\nFirst import:");
  const dbDir = mkdtempSync(join(tmpdir(), "gelp-selfcheck-"));
  const sqlite = new Database(join(dbDir, "test.db"));
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: resolve("drizzle") });

  const userId = randomUUID();
  db.insert(users)
    .values({ id: userId, email: "self@check.test", createdAt: Date.now() })
    .run();

  const client = new StubPlacesClient();
  // The self-check is synchronous below because runImport is awaited in-line.
  return (async () => {
    const first = await runImport(db, userId, parsed, client, "upload");
    assert(first.lists === 3, "imported 3 lists");
    assert(first.places === 7, "imported 7 places");
    assert(
      first.apiCalls === 5,
      `5 API calls (2 JSON places cost 0), got ${first.apiCalls}`,
    );
    assert(
      first.cacheHits === 0,
      `0 cache hits on first import, got ${first.cacheHits}`,
    );
    assert(client.calls === 5, "stub client called exactly 5 times");

    // 4. Re-import the same data: the cache should cover everything.
    console.log("\nSecond import (cache):");
    const before = client.calls;
    const second = await runImport(db, userId, parsed, client, "upload");
    assert(
      second.apiCalls === 0,
      `0 API calls on re-import, got ${second.apiCalls}`,
    );
    assert(
      second.cacheHits === 7,
      `7 cache hits on re-import, got ${second.cacheHits}`,
    );
    assert(
      client.calls === before,
      "stub client not called again on re-import",
    );

    // Sanity check that re-import replaced rather than duplicated places.
    const totalPlaces = db
      .select()
      .from(schema.places)
      .where(eq(schema.places.userId, userId))
      .all().length;
    assert(totalPlaces === 7, `still 7 places after re-import, got ${totalPlaces}`);

    // 5. Summary.
    console.log("");
    if (failures.length === 0) {
      console.log("SELF-CHECK PASSED");
      process.exit(0);
    } else {
      console.log(`SELF-CHECK FAILED: ${failures.length} assertion(s)`);
      for (const f of failures) console.log(`  - ${f}`);
      process.exit(1);
    }
  })();
}

main();
