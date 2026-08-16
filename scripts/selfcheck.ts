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
import {
  cidFromMapsUrl,
  coordsFromMapsUrl,
  ftidFromMapsUrl,
  isPlaceEntry,
  parseTakeoutZip,
  regionKeyFromMapsUrl,
} from "../lib/takeout";
import {
  enqueuePlaces,
  queueSummary,
  runImport,
  UNAVAILABLE_TTL_MS,
} from "../lib/import";
import { selectCandidate } from "../lib/places";
import type {
  PlaceLookup,
  PlaceResult,
  PlacesClient,
  SearchOptions,
} from "../lib/places";
import { consensusCenters, haversineMeters } from "../lib/geo";
import {
  ensureShare,
  getShareToken,
  resolveShare,
  revokeShare,
  rotateShare,
} from "../lib/share";
import {
  CATEGORY_GROUPS,
  CATEGORY_TREE,
  TIER1,
  groupOf,
  isPlaced,
  tier1Of,
} from "../lib/category-tree";

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
  // Every options object the pipeline passed, so a test can assert that a
  // lookup was actually aimed rather than fired blind.
  readonly seen: Array<SearchOptions | undefined> = [];
  constructor(
    private outcome: "ok" | "not_found" | "unavailable" | "throw" = "ok",
  ) {}

  async searchText(
    query: string,
    opts?: SearchOptions,
  ): Promise<PlaceLookup> {
    this.calls += 1;
    this.seen.push(opts);
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

// A stub that answers from a fixed gazetteer, so a test can stage the exact
// failure this work exists to fix: a title whose top global match is on the
// wrong continent, with the right place available further down the results.
class GazetteerPlacesClient implements PlacesClient {
  calls = 0;
  constructor(private readonly byQuery: Record<string, PlaceResult[]>) {}

  async searchText(
    query: string,
    opts?: SearchOptions,
  ): Promise<PlaceLookup> {
    this.calls += 1;
    const candidates = this.byQuery[query] ?? [];
    const chosen = selectCandidate(candidates, opts);
    if (!chosen) return { status: "not_found" };
    return { status: "ok", place: chosen };
  }
}

// Two places named the same: the one Google ranks first globally, and the one
// actually saved. Coordinates are the real ones for Groningen and Tokyo.
const GRONINGEN: PlaceResult = {
  placeId: "nl-zondag",
  name: "Zondag",
  address: "Kruissingel 1, Groningen, Netherlands",
  lat: 53.224515,
  lng: 6.555579,
  category: "cafe",
  types: ["cafe"],
};
const TOKYO_ZONDAG: PlaceResult = {
  placeId: "jp-zondag",
  name: "zondag",
  address: "Shibuya, Tokyo, Japan",
  lat: 35.6595,
  lng: 139.7005,
  category: "bar",
  types: ["bar"],
};
const TOKYO_NEIGHBOURS: PlaceResult[] = [
  {
    placeId: "jp-a",
    name: "Tokyo Place A",
    address: "Shinjuku, Tokyo, Japan",
    lat: 35.6938,
    lng: 139.7034,
    category: "restaurant",
    types: ["restaurant"],
  },
  {
    placeId: "jp-b",
    name: "Tokyo Place B",
    address: "Chiyoda, Tokyo, Japan",
    lat: 35.6812,
    lng: 139.7671,
    category: "restaurant",
    types: ["restaurant"],
  },
  {
    placeId: "jp-c",
    name: "Tokyo Place C",
    address: "Minato, Tokyo, Japan",
    lat: 35.6586,
    lng: 139.7454,
    category: "restaurant",
    types: ["restaurant"],
  },
];

// A Maps URL of the shape a Takeout list CSV actually contains: the feature id
// carries the region, `0x6018…` being the cell the Tokyo places share.
function tokyoUrl(cid: string): string {
  return `https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x6018f36b17e5f86b:0x${cid}`;
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

  // The third row is a dropped pin: no place attached, but the URL names the
  // position outright, so it must cost no lookup and land exactly there. Its
  // URL is quoted because it contains a comma — which is exactly how Takeout
  // writes it, and reading it unquoted would truncate the coordinates.
  const wantToGo = [
    "Title,Note,URL",
    "Museum of Math,Fun,https://maps.google.com/?cid=4",
    "Skyline Park,,https://maps.google.com/?cid=5",
    `"35°01'35.8""N 135°44'21.0""E",,"https://www.google.com/maps/search/35.0266227,135.7391739"`,
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
  assert(byName["Want to go"]?.places.length === 3, "Want to go has 3 places");
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

  // A list CSV carries no coordinate column, but its URLs sometimes carry the
  // position anyway. Mining it is exact and free, where a text search for a
  // title like `35°01'35.8"N` is neither.
  console.log("\nMaps URL mining:");
  const pin = byName["Want to go"]?.places[2];
  assert(
    pin?.lat === 35.0266227 && pin?.lng === 135.7391739,
    `dropped-pin coordinates read from the URL, got ${pin?.lat},${pin?.lng}`,
  );
  assert(
    coordsFromMapsUrl("https://www.google.com/maps/place/X/@35.68,139.76,17z")
      ?.lat === 35.68,
    "coordinates read from an @lat,lng viewport anchor",
  );
  assert(
    coordsFromMapsUrl("https://www.google.com/maps/place/X/data=!3d35.68!4d139.76")
      ?.lng === 139.76,
    "coordinates read from a !3d/!4d data blob",
  );
  assert(
    coordsFromMapsUrl("https://maps.google.com/?cid=1") === undefined,
    "a cid-only URL yields no coordinates rather than a bogus one",
  );
  assert(
    coordsFromMapsUrl("https://www.google.com/maps/search/0,0") === undefined,
    "Null Island is rejected as a degraded URL, not treated as a place",
  );
  assert(
    regionKeyFromMapsUrl(tokyoUrl("1")) === "6018f36b17e5f86b",
    "region key read from the feature id, left-padded to a fixed width",
  );
  assert(
    regionKeyFromMapsUrl("https://maps.google.com/?cid=1") === undefined,
    "a URL with no feature id has no region",
  );

  // The CID is the half of the feature id that identifies the place. Both URL
  // shapes Google writes must reduce to the same one, or the same place saved
  // two different ways would be resolved — and billed — twice.
  console.log("\nPlace identity:");
  assert(
    cidFromMapsUrl(tokyoUrl("8e04bbd5183744da")) === "0x8e04bbd5183744da",
    `CID read from a feature id, got ${cidFromMapsUrl(tokyoUrl("8e04bbd5183744da"))}`,
  );
  assert(
    cidFromMapsUrl("https://maps.google.com/?cid=10233510777201312986") ===
      "0x8e04bbd5183744da",
    "the decimal ?cid= form reduces to the same CID as the feature id",
  );
  assert(
    cidFromMapsUrl(tokyoUrl("1")) === "0x0000000000000001",
    "a short CID is padded, so one place is always one key",
  );
  assert(
    ftidFromMapsUrl(tokyoUrl("1")) === "0x6018f36b17e5f86b:0x1",
    "the whole feature id is kept for tracing a row back to its URL",
  );

  // A saved list holds whatever the user starred, and not all of it is a place.
  // Searching for a shirt's title returns a shop, which then gets pinned.
  assert(
    isPlaceEntry({ title: "Somewhere", mapsUrl: tokyoUrl("1") }),
    "a place with a feature id is searchable",
  );
  assert(
    isPlaceEntry({ title: "Only a title" }),
    "an entry with no URL at all is still searchable",
  );
  assert(
    !isPlaceEntry({
      title: "Nike Flex Men's 8\" Training Shorts",
      mapsUrl: "https://www.google.com/shopping/product/6866212677646588675",
    }),
    "a saved shopping item is not a place and is never looked up",
  );
  assert(
    !isPlaceEntry({ title: "Ryuichi Sakamoto: Coda", mapsUrl: "https://www.google.com" }),
    "a saved film pointing at bare google.com is not a place either",
  );

  // The consensus step: which position a region's answers agree on. Three
  // Tokyo answers and one stray in the Netherlands must settle on Tokyo.
  console.log("\nRegion consensus:");
  const centers = consensusCenters([
    ...TOKYO_NEIGHBOURS.map((p) => ({
      regionKey: "6018f36b17e5f86b",
      point: { lat: p.lat, lng: p.lng },
    })),
    {
      regionKey: "6018f36b17e5f86b",
      point: { lat: GRONINGEN.lat, lng: GRONINGEN.lng },
    },
  ]);
  assert(centers.length === 1, `one region reached consensus, got ${centers.length}`);
  assert(
    centers[0] !== undefined &&
      haversineMeters(centers[0].point, { lat: 35.68, lng: 139.74 }) < 20_000,
    "consensus lands on Tokyo, not on the outlier in Groningen",
  );
  assert(
    consensusCenters([
      { regionKey: "aaaa", point: { lat: 35.68, lng: 139.76 } },
      { regionKey: "aaaa", point: { lat: 53.22, lng: 6.55 } },
      { regionKey: "aaaa", point: { lat: -33.86, lng: 151.2 } },
    ]).length === 0,
    "answers that scatter without a majority claim no region at all",
  );

  // Selection: with no bias the top result wins, as before. With one, a result
  // outside the allowed radius is passed over for a closer candidate, and if
  // none qualify the honest answer is that nothing was found.
  console.log("\nCandidate selection:");
  assert(
    selectCandidate([GRONINGEN, TOKYO_ZONDAG])?.placeId === "nl-zondag",
    "unbiased selection keeps the old top-result behaviour",
  );
  const tokyoBias = {
    bias: {
      lat: 35.68,
      lng: 139.74,
      biasMeters: 25_000,
      maxMeters: 120_000,
    },
  };
  assert(
    selectCandidate([GRONINGEN, TOKYO_ZONDAG], tokyoBias)?.placeId ===
      "jp-zondag",
    "a biased selection skips the top global match for the one in the region",
  );
  assert(
    selectCandidate([GRONINGEN], tokyoBias) === undefined,
    "a lone out-of-region candidate is rejected rather than pinned",
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
    assert(first.places === 8, "imported 8 places");
    assert(
      first.apiCalls === 5,
      `5 API calls (2 JSON places and 1 pinned URL cost 0), got ${first.apiCalls}`,
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
    // Five of the eight come back from the cache. The other three are answered
    // before the cache is consulted at all — two from Saved Places.json
    // geometry and one from a URL that states its position — so they are not
    // cache hits, they are places the cache was never asked about.
    assert(
      second.cacheHits === 5,
      `5 cache hits on re-import, got ${second.cacheHits}`,
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
      totalPlaces === 8,
      `still 8 places after re-import, got ${totalPlaces}`,
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
      `the removed list's 3 places went with it, got ${orphans.length} left`,
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

    // 10. The failure this work exists to fix, end to end: a list of Japanese
    //     places whose titles have better-known matches elsewhere. Nothing in
    //     the export says where any of them are — only the feature ids say they
    //     belong together — so the region has to be established by agreement.
    console.log("\nMislocated place (region consensus):");
    const jpUser = randomUUID();
    await db.insert(users).values({
      id: jpUser,
      email: "jp@check.test",
      createdAt: Date.now(),
    });

    const gazetteer = new GazetteerPlacesClient({
      // The saved bar in Tokyo, outranked globally by a café in Groningen.
      zondag: [GRONINGEN, TOKYO_ZONDAG],
      "Tokyo Place A": [TOKYO_NEIGHBOURS[0]],
      "Tokyo Place B": [TOKYO_NEIGHBOURS[1]],
      "Tokyo Place C": [TOKYO_NEIGHBOURS[2]],
    });
    const tokyoList = {
      lists: [
        {
          name: "Tokyo WTG",
          places: [
            { title: "zondag", mapsUrl: tokyoUrl("1") },
            { title: "Tokyo Place A", mapsUrl: tokyoUrl("2") },
            { title: "Tokyo Place B", mapsUrl: tokyoUrl("3") },
            { title: "Tokyo Place C", mapsUrl: tokyoUrl("4") },
          ],
        },
      ],
    };
    await runImport(db, jpUser, tokyoList, gazetteer, "upload");

    const jpRows = await db
      .select()
      .from(schema.placeCache)
      .where(eq(schema.placeCache.key, tokyoUrl("1")));
    const zondag = jpRows[0];
    assert(
      zondag?.placeId === "jp-zondag",
      `the Tokyo bar wins over the Dutch café, got ${zondag?.placeId} (${zondag?.address})`,
    );
    assert(
      zondag !== undefined &&
        zondag.lat !== null &&
        zondag.lng !== null &&
        haversineMeters(
          { lat: zondag.lat, lng: zondag.lng },
          { lat: 35.68, lng: 139.74 },
        ) < 50_000,
      "the corrected place lands in Tokyo, not in Europe",
    );
    assert(
      gazetteer.calls === 5,
      `only the outlier is looked up twice: 5 calls expected, got ${gazetteer.calls}`,
    );

    // With no candidate in the region at all, the place is left unresolved.
    // A place with no pin is recoverable; a pin on the wrong continent is the
    // bug being fixed, so this direction of failure is the safe one.
    const strandedUser = randomUUID();
    await db.insert(users).values({
      id: strandedUser,
      email: "stranded@check.test",
      createdAt: Date.now(),
    });
    const onlyDutch = new GazetteerPlacesClient({
      zondag: [GRONINGEN],
      "Tokyo Place A": [TOKYO_NEIGHBOURS[0]],
      "Tokyo Place B": [TOKYO_NEIGHBOURS[1]],
      "Tokyo Place C": [TOKYO_NEIGHBOURS[2]],
    });
    // Distinct URLs, so these are distinct cache keys: the cache is global, and
    // reusing the list above would just serve the answer it already resolved.
    const strandedList = {
      lists: [
        {
          name: "Tokyo WTG",
          places: tokyoList.lists[0].places.map((p, i) => ({
            ...p,
            mapsUrl: tokyoUrl(`1${i}`),
          })),
        },
      ],
    };
    await runImport(db, strandedUser, strandedList, onlyDutch, "upload");
    const stranded = (
      await db
        .select()
        .from(schema.placeCache)
        .where(eq(schema.placeCache.key, tokyoUrl("10")))
    )[0];
    assert(
      stranded?.status === "not_found" && stranded?.lat === null,
      `an answer that is nowhere near its region is refused, got ${stranded?.status} at ${stranded?.lat}`,
    );

    // A place is asked about once. Even a refusal stands, because asking the
    // same question of the same data returns the same answer — a wrong pin is
    // corrected by flagging it, not by looking it up again.
    console.log("\nLooked up once:");
    const asked = onlyDutch.calls;
    const again = await runImport(
      db,
      strandedUser,
      strandedList,
      onlyDutch,
      "upload",
    );
    assert(
      again.apiCalls === 0 && onlyDutch.calls === asked,
      `re-import asks nothing again, got ${again.apiCalls} call(s)`,
    );

    // Coordinates the export's own URL stated are labelled as such, so the UI
    // can say this pin is known rather than guessed.
    const pinned = (
      await db
        .select()
        .from(schema.placeCache)
        .where(
          eq(
            schema.placeCache.key,
            "https://www.google.com/maps/search/35.0266227,135.7391739",
          ),
        )
    )[0];
    assert(
      pinned?.resolver === "url" && pinned?.lat === 35.0266227,
      `a URL-pinned place is labelled as stated by the export, got ${pinned?.resolver}`,
    );

    // 11. place_coords outranks everything: a place in it is never searched
    //     for, and its coordinates win over whatever the cache already holds.
    console.log("\nAuthoritative coordinates:");
    const coordsUser = randomUUID();
    await db.insert(users).values({
      id: coordsUser,
      email: "coords@check.test",
      createdAt: Date.now(),
    });
    await db.insert(schema.placeCoords).values({
      id: randomUUID(),
      cid: cidFromMapsUrl(tokyoUrl("1")) ?? null,
      ftid: ftidFromMapsUrl(tokyoUrl("1")) ?? null,
      mapsUrl: tokyoUrl("1"),
      lat: TOKYO_ZONDAG.lat,
      lng: TOKYO_ZONDAG.lng,
      title: "zondag",
      source: "browser",
      resolvedAt: Date.now(),
    });
    const wouldGuess = new GazetteerPlacesClient({ zondag: [GRONINGEN] });
    const authoritative = await runImport(
      db,
      coordsUser,
      { lists: [{ name: "One", places: [{ title: "zondag", mapsUrl: tokyoUrl("1") }] }] },
      wouldGuess,
      "upload",
    );
    assert(
      authoritative.apiCalls === 0 && wouldGuess.calls === 0,
      `a place in place_coords is never looked up, got ${authoritative.apiCalls} call(s)`,
    );
    const mirrored = (
      await db
        .select()
        .from(schema.placeCache)
        .where(eq(schema.placeCache.key, tokyoUrl("1")))
    )[0];
    assert(
      mirrored?.resolver === "coords" && mirrored?.lat === TOKYO_ZONDAG.lat,
      `the cache is corrected to match place_coords, got ${mirrored?.resolver} at ${mirrored?.lat}`,
    );

    // 12. A queued import guesses at nothing. Places it cannot already answer
    //     for go on the queue instead of to the Places API.
    console.log("\nQueued import:");
    const queuedUser = randomUUID();
    await db.insert(users).values({
      id: queuedUser,
      email: "queued@check.test",
      createdAt: Date.now(),
    });
    const neverCalled = new GazetteerPlacesClient({});
    const queuedRun = await runImport(
      db,
      queuedUser,
      {
        lists: [
          {
            name: "Queued",
            places: [
              { title: "zondag", mapsUrl: tokyoUrl("1") }, // already in place_coords
              { title: "Unknown Bar", mapsUrl: tokyoUrl("90") },
              { title: "Another Bar", mapsUrl: tokyoUrl("91") },
              // A saved shopping item: not a place, so not queued either.
              {
                title: "Nike Flex Shorts",
                mapsUrl: "https://www.google.com/shopping/product/123",
              },
            ],
          },
        ],
      },
      neverCalled,
      "upload",
      "queued",
    );
    assert(
      neverCalled.calls === 0,
      `a queued import calls the Places API zero times, got ${neverCalled.calls}`,
    );
    assert(
      queuedRun.queued === 2,
      `the two unknown places are queued, got ${queuedRun.queued}`,
    );
    const pending = await db
      .select()
      .from(schema.placeQueue)
      .where(eq(schema.placeQueue.status, "pending"));
    assert(
      pending.length === 2 && pending.every((r) => r.reason === "import"),
      `the queue holds exactly those two, marked as coming from an import, got ${pending.length}`,
    );
    assert(
      pending.every((r) => r.cid !== null),
      "each queued row carries the CID the resolver will need",
    );

    // Re-importing does not disturb rows already waiting.
    const requeued = await runImport(
      db,
      queuedUser,
      {
        lists: [
          {
            name: "Queued",
            places: [{ title: "Unknown Bar", mapsUrl: tokyoUrl("90") }],
          },
        ],
      },
      neverCalled,
      "upload",
      "queued",
    );
    assert(
      requeued.queued === 0,
      `a place already on the queue is not queued twice, got ${requeued.queued}`,
    );

    // Flagging a pin puts it on the same queue as a queued import, because it
    // is the same work — only the reason differs.
    await enqueuePlaces(
      db,
      [{ mapsUrl: tokyoUrl("92"), title: "Wrongly pinned" }],
      "flagged",
      queuedUser,
    );
    const summary = await queueSummary(db);
    assert(
      summary.pending === 3 &&
        summary.fromImport === 2 &&
        summary.flagged === 1,
      `the queue summary splits by reason: got ${summary.pending} pending (${summary.fromImport} import, ${summary.flagged} flagged)`,
    );
    assert(
      summary.oldestAt !== null && summary.oldestAt <= Date.now(),
      "the summary reports when the longest-waiting entry was queued",
    );

    // A place whose Google id no longer resolves is not queued: a resolve run
    // opens its map page by that id, and there is no page. A text search is a
    // different route — it asks by title and never held the id — so it is
    // deliberately still made. The id died, not usually the place.
    console.log("\nTombstoned ids:");
    // Its own user: an import replaces that user's lists wholesale, so sharing
    // one with the test above would delete the queue rows it just asserted on.
    const goneUser = randomUUID();
    await db.insert(users).values({
      id: goneUser,
      email: "gone@check.test",
      createdAt: Date.now(),
    });
    const goneUrl = tokyoUrl("93");
    await db.insert(schema.tombstoneCid).values({
      id: randomUUID(),
      cid: cidFromMapsUrl(goneUrl)!,
      ftid: ftidFromMapsUrl(goneUrl) ?? null,
      mapsUrl: goneUrl,
      title: "Closed Bar",
      settledUrl: "https://www.google.com/maps/place//@37.28,-121.84,14z/",
      noticedAt: Date.now(),
    });
    const goneList = {
      lists: [
        { name: "Gone", places: [{ title: "Closed Bar", mapsUrl: goneUrl }] },
      ],
    };
    const goneQueued = await runImport(
      db,
      goneUser,
      goneList,
      neverCalled,
      "upload",
      "queued",
    );
    assert(
      goneQueued.queued === 0 && goneQueued.gone === 1,
      `a queued import does not queue a dead id: got queued=${goneQueued.queued}, gone=${goneQueued.gone}`,
    );

    const goneSearcher = new GazetteerPlacesClient({});
    const goneFast = await runImport(
      db,
      goneUser,
      goneList,
      goneSearcher,
      "upload",
      "fast",
    );
    assert(
      goneSearcher.calls === 1 && goneFast.gone === 0,
      `a fast import still searches by title for a dead id: got ${goneSearcher.calls} calls, gone=${goneFast.gone}`,
    );

    // Flagging one is refused for the same reason: the user can ask, but the
    // queue is for work that can be done.
    const flaggedGone = await enqueuePlaces(
      db,
      [{ mapsUrl: goneUrl, title: "Closed Bar" }],
      "flagged",
      goneUser,
    );
    assert(
      flaggedGone === 0,
      `flagging a dead id does not open a queue entry, got ${flaggedGone}`,
    );

    // 13. The round trip a resolve run makes: a queued place gains real
    //     coordinates, its queue entry closes, and the map is right without
    //     waiting for another import.
    console.log("\nResolve round trip:");
    const target = tokyoUrl("90");
    await db.insert(schema.placeCoords).values({
      id: randomUUID(),
      cid: cidFromMapsUrl(target) ?? null,
      ftid: ftidFromMapsUrl(target) ?? null,
      mapsUrl: target,
      lat: 35.6812,
      lng: 139.7671,
      title: "Unknown Bar",
      source: "browser",
      resolvedAt: Date.now(),
    });
    await db
      .update(schema.placeQueue)
      .set({ status: "done", handledAt: Date.now() })
      .where(eq(schema.placeQueue.mapsUrl, target));

    const afterResolve = await queueSummary(db);
    assert(
      afterResolve.pending === 2,
      `closing one entry leaves the rest pending, got ${afterResolve.pending}`,
    );

    // The place had no pin and no cache row at all — a queued import writes
    // neither — so this only works if reads reach place_coords through the CID
    // stored on the place itself.
    const placed = await db
      .select({ cid: schema.places.cid, cacheKey: schema.places.cacheKey })
      .from(schema.places)
      .where(eq(schema.places.mapsUrl, target));
    assert(
      placed[0]?.cid === cidFromMapsUrl(target) && placed[0]?.cacheKey === null,
      `a queued place carries its CID and no cache row, got cid=${placed[0]?.cid} cacheKey=${placed[0]?.cacheKey}`,
    );

    // A re-import must not re-queue a place that now has coordinates, and must
    // not pay for it either.
    const settled = await runImport(
      db,
      queuedUser,
      {
        lists: [
          {
            name: "Queued",
            places: [{ title: "Unknown Bar", mapsUrl: target }],
          },
        ],
      },
      neverCalled,
      "upload",
      "queued",
    );
    assert(
      settled.queued === 0 && settled.apiCalls === 0,
      `a resolved place is neither re-queued nor looked up, got ${settled.queued} queued / ${settled.apiCalls} call(s)`,
    );
    const mirroredBack = (
      await db
        .select()
        .from(schema.placeCache)
        .where(eq(schema.placeCache.key, target))
    )[0];
    assert(
      mirroredBack?.resolver === "coords" && mirroredBack?.lat === 35.6812,
      `the import mirrors the resolved coordinates into the cache, got ${mirroredBack?.resolver}`,
    );

    // 14. Share links: one per user, revocable, and scoped to their owner.
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

    console.log("\nCategory tree:");
    // The tree is hand-written data, so the failure to guard against is a typo:
    // a category listed under two umbrellas, or an umbrella that disagrees with
    // itself. Both would quietly move places between filters.
    const twoParents = new Map<string, string[]>();
    for (const [parent, children] of Object.entries(CATEGORY_TREE)) {
      for (const child of children) {
        twoParents.set(child, [...(twoParents.get(child) ?? []), parent]);
      }
    }
    const ambiguous = [...twoParents].filter(([, ps]) => ps.length > 1);
    assert(
      ambiguous.length === 0,
      `no category sits under two umbrellas${ambiguous.length ? `, got ${ambiguous.map(([c, ps]) => `${c}→${ps.join("/")}`).join(", ")}` : ""}`,
    );
    const selfInconsistent = TIER1.filter((t) => tier1Of(t) !== t);
    assert(
      selfInconsistent.length === 0,
      `every umbrella is its own tier 1${selfInconsistent.length ? `, got ${selfInconsistent.join(", ")}` : ""}`,
    );
    const misplaced = Object.entries(CATEGORY_TREE).flatMap(([parent, children]) =>
      children.filter((child) => tier1Of(child) !== parent),
    );
    assert(
      misplaced.length === 0,
      `every category resolves to the umbrella it is listed under${misplaced.length ? `, got ${misplaced.join(", ")}` : ""}`,
    );
    // A category Google invents after this table was written must still land
    // somewhere browsable rather than disappearing from the filter.
    assert(
      tier1Of("okonomiyaki_restaurant") === "restaurant" && !isPlaced("okonomiyaki_restaurant"),
      "an unknown category falls back by suffix and is reported as unplaced",
    );
    assert(tier1Of("shed_thing") === "other", "an unrecognisable category lands in other");

    // The group layer is the same hand-written data one level up, and has the
    // same failure: an umbrella nobody assigned silently lands in Services,
    // where a restaurant would be filed next to the dentist.
    const grouped = new Set(Object.values(CATEGORY_GROUPS).flat());
    const ungrouped = TIER1.filter((t) => !grouped.has(t));
    assert(
      ungrouped.length === 0,
      `every umbrella sits in a group${ungrouped.length ? `, got ${ungrouped.join(", ")}` : ""}`,
    );
    const notAnUmbrella = [...grouped].filter((t) => !TIER1.includes(t));
    assert(
      notAnUmbrella.length === 0,
      `every grouped name is a real umbrella${notAnUmbrella.length ? `, got ${notAnUmbrella.join(", ")}` : ""}`,
    );
    const twoGroups = new Map<string, string[]>();
    for (const [group, tier1s] of Object.entries(CATEGORY_GROUPS)) {
      for (const t of tier1s) {
        twoGroups.set(t, [...(twoGroups.get(t) ?? []), group]);
      }
    }
    const inTwo = [...twoGroups].filter(([, gs]) => gs.length > 1);
    assert(
      inTwo.length === 0,
      `no umbrella sits in two groups${inTwo.length ? `, got ${inTwo.map(([t, gs]) => `${t}→${gs.join("/")}`).join(", ")}` : ""}`,
    );
    assert(
      groupOf(tier1Of("okonomiyaki_restaurant")) === "food_and_drink",
      "a category Google invents still reaches a group people browse",
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
