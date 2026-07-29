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
import { runImport, UNAVAILABLE_TTL_MS } from "../lib/import";
import type { PlaceLookup, PlaceResult, PlacesClient } from "../lib/places";
import {
  ensureShare,
  getShareToken,
  resolveShare,
  revokeShare,
  rotateShare,
} from "../lib/share";

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
// the pipeline never touches the network. `outcome` lets a test drive the
// unresolved paths without a real API.
class StubPlacesClient implements PlacesClient {
  calls = 0;
  constructor(
    private outcome: "ok" | "not_found" | "unavailable" | "throw" = "ok",
  ) {}

  async searchText(query: string): Promise<PlaceLookup> {
    this.calls += 1;
    if (this.outcome === "throw") throw new Error("stub blew up mid-import");
    if (this.outcome === "not_found") return { status: "not_found" };
    if (this.outcome === "unavailable") {
      return { status: "unavailable", reason: "stub outage" };
    }
    const place: PlaceResult = {
      placeId: `stub-${this.calls}`,
      name: query,
      address: "123 Test St",
      lat: 40 + this.calls * 0.01,
      lng: -70 - this.calls * 0.01,
      category: "thai_restaurant",
      types: ["thai_restaurant", "restaurant"],
    };
    return { status: "ok", place };
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

    // Count the statements aimed at place_cache, so the batched lookup cannot
    // quietly regress to a round trip per place. Transactions take their own
    // connection and bypass this wrapper — which is fine, the enrichment half
    // being measured here runs outside them.
    let cacheQueries = 0;
    const poolQuery = pool.query.bind(pool);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pool as any).query = (...args: any[]) => {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
      if (typeof text === "string" && /from "place_cache"/i.test(text)) {
        cacheQueries += 1;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (poolQuery as any)(...args);
    };

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
    assert(
      cacheQueries === 3,
      `one cache lookup per list, not per place: 3 expected, got ${cacheQueries}`,
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

    // 5. Concurrent imports must converge on one list per name, not fork.
    console.log("\nConcurrent import (list identity):");
    await Promise.all([
      runImport(db, userId, parsed, client, "upload"),
      runImport(db, userId, parsed, client, "drive"),
    ]);
    const listRows = await db
      .select()
      .from(schema.lists)
      .where(eq(schema.lists.userId, userId));
    assert(
      listRows.length === 3,
      `still 3 lists after two concurrent imports, got ${listRows.length}`,
    );

    // 6. A failed lookup is cached only briefly, so it is retried; a place the
    //    API positively reports as missing is not.
    console.log("\nUnresolved cache lifetime:");
    const outageUser = randomUUID();
    await db.insert(users).values({
      id: outageUser,
      email: "outage@check.test",
      createdAt: Date.now(),
    });
    // Fresh titles with no Maps URL and no coordinates, so these keys are not
    // already in the cache and must go through the client.
    const csvOnly = {
      lists: [
        {
          name: "Outage list",
          places: [{ title: "Nowhere Cafe" }, { title: "Closed Bookshop" }],
        },
      ],
    };
    const down = new StubPlacesClient("unavailable");
    const outage = await runImport(db, outageUser, csvOnly, down, "upload");
    assert(outage.apiCalls === 2, `outage import made 2 calls, got ${outage.apiCalls}`);

    const stillDown = await runImport(db, outageUser, csvOnly, down, "upload");
    assert(
      stillDown.apiCalls === 0 && stillDown.cacheHits === 2,
      `a fresh 'unavailable' row is not retried immediately, got ${stillDown.apiCalls} call(s)`,
    );

    // Age the unresolved rows past their lifetime; the next import retries.
    await db
      .update(schema.placeCache)
      .set({ fetchedAt: Date.now() - UNAVAILABLE_TTL_MS - 1 })
      .where(eq(schema.placeCache.status, "unavailable"));
    const recovered = new StubPlacesClient("ok");
    const retry = await runImport(db, outageUser, csvOnly, recovered, "upload");
    assert(
      retry.apiCalls === 2,
      `an expired 'unavailable' row is retried, got ${retry.apiCalls} call(s)`,
    );

    const resolvedRows = await db
      .select()
      .from(schema.placeCache)
      .where(eq(schema.placeCache.status, "ok"));
    assert(
      resolvedRows.some((r) => r.placeId !== null),
      "the retry replaced the failed rows with resolved ones",
    );

    // 7. An import that dies partway must leave the previous contents intact,
    //    never a list emptied by the delete that precedes the re-insert.
    console.log("\nFailed import (atomicity):");
    const exploding = {
      lists: [
        {
          name: "Outage list",
          places: [{ title: "Nowhere Cafe" }, { title: "Brand New Place" }],
        },
      ],
    };
    let threw = false;
    try {
      await runImport(
        db,
        outageUser,
        exploding,
        new StubPlacesClient("throw"),
        "upload",
      );
    } catch {
      threw = true;
    }
    assert(threw, "a client failure still surfaces to the caller");
    const survivors = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.userId, outageUser));
    assert(
      survivors.length === 2,
      `the list kept its 2 places after the failed import, got ${survivors.length}`,
    );

    // 8. A list the export no longer contains is deleted — but an export that
    //    parsed to nothing deletes nothing.
    console.log("\nRemoved lists:");
    const shrunk = {
      lists: parsed.lists.filter((l) => l.name !== "Want to go"),
    };
    const pruned = await runImport(db, userId, shrunk, client, "upload");
    assert(
      pruned.listsRemoved === 1,
      `dropped list removed, got ${pruned.listsRemoved}`,
    );
    const remaining = await db
      .select()
      .from(schema.lists)
      .where(eq(schema.lists.userId, userId));
    assert(remaining.length === 2, `2 lists remain, got ${remaining.length}`);
    const orphans = await db
      .select()
      .from(schema.places)
      .where(eq(schema.places.userId, userId));
    assert(
      orphans.length === 5,
      `the removed list's 2 places went with it, got ${orphans.length} left`,
    );

    const empty = await runImport(db, userId, { lists: [] }, client, "upload");
    assert(
      empty.listsRemoved === 0,
      `an empty export removes nothing, got ${empty.listsRemoved}`,
    );
    const afterEmpty = await db
      .select()
      .from(schema.lists)
      .where(eq(schema.lists.userId, userId));
    assert(
      afterEmpty.length === 2,
      `2 lists survive an empty export, got ${afterEmpty.length}`,
    );

    // 9. A place repeated inside one list is resolved once. The prefetched
    //    lookup happens before any of it is written, so the second appearance
    //    can only be a hit if the write is folded back into it.
    console.log("\nRepeated place in one list:");
    const dupUser = randomUUID();
    await db.insert(users).values({
      id: dupUser,
      email: "dup@check.test",
      createdAt: Date.now(),
    });
    const twice = new StubPlacesClient("ok");
    const dup = await runImport(
      db,
      dupUser,
      {
        lists: [
          {
            name: "Doubled",
            places: [{ title: "Same Cafe" }, { title: "Same Cafe" }],
          },
        ],
      },
      twice,
      "upload",
    );
    assert(
      dup.apiCalls === 1 && dup.cacheHits === 1,
      `the repeat costs no second call: got ${dup.apiCalls} call(s), ${dup.cacheHits} hit(s)`,
    );

    // 10. Share links: one per user, revocable, and scoped to their owner.
    console.log("\nShare links:");
    const token = await ensureShare(db, userId);
    assert(token.length >= 32, `token is long enough, got ${token.length} chars`);
    assert(
      (await ensureShare(db, userId)) === token,
      "asking again returns the same link rather than breaking the old one",
    );

    const shared = await resolveShare(db, token);
    assert(shared !== null, "the token resolves to a map");
    assert(
      shared?.userId === userId,
      "the token resolves to its own owner, not another user",
    );

    const rotated = await rotateShare(db, userId);
    assert(rotated !== token, "a new link is a different token");
    assert(
      (await resolveShare(db, token)) === null,
      "the previous link stops resolving once replaced",
    );

    await revokeShare(db, userId);
    assert(
      (await resolveShare(db, rotated)) === null,
      "revoking stops the current link too",
    );
    assert(
      (await getShareToken(db, userId)) === null,
      "no link remains after revoking",
    );
  } finally {
    // 9. Tear down the throwaway database.
    await pool.end();
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    await admin.end();
  }

  // 10. Summary.
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
