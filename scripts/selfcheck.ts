import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import AdmZip from "adm-zip";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
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

// The base Postgres server to run against. The self-check never touches any app
// database directly; it creates a throwaway database on the same server, runs
// everything there, and drops it at the end, so repeated runs stay hermetic.
//
// CREATE/DROP DATABASE needs the `postgres` superuser — the app's own gelp_rw
// role deliberately can't do either (and can't even connect to the maintenance
// DB). So this reads SELFCHECK_ADMIN_URL, not DATABASE_URL; the default matches
// the shared minikube server's out-of-band superuser password default ("dev",
// per snoopy_home's runbook), reached through the `npm run db:up` port-forward.
function baseUrl(): string {
  return (
    process.env.SELFCHECK_ADMIN_URL ??
    "postgres://postgres:dev@localhost:5432/postgres"
  );
}

async function main() {
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

  // 3. Create a throwaway database on the target server for a fresh import.
  console.log("\nFirst import:");
  const dbName = `gelp_selfcheck_${randomUUID().replace(/-/g, "")}`;
  const admin = new Pool({ connectionString: baseUrl() });
  await admin.query(`CREATE DATABASE ${dbName}`);

  const scratchUrl = new URL(baseUrl());
  scratchUrl.pathname = `/${dbName}`;
  const pool = new Pool({ connectionString: scratchUrl.toString() });

  try {
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: resolve("drizzle") });

    const userId = randomUUID();
    await db
      .insert(users)
      .values({ id: userId, email: "self@check.test", createdAt: Date.now() });

    const client = new StubPlacesClient();
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
    const totalPlaces = (
      await db
        .select()
        .from(schema.places)
        .where(eq(schema.places.userId, userId))
    ).length;
    assert(
      totalPlaces === 7,
      `still 7 places after re-import, got ${totalPlaces}`,
    );
  } finally {
    // 5. Tear down the throwaway database.
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  // 6. Summary.
  console.log("");
  if (failures.length === 0) {
    console.log("SELF-CHECK PASSED");
    process.exit(0);
  } else {
    console.log(`SELF-CHECK FAILED: ${failures.length} assertion(s)`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
