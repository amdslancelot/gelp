// Geographic helpers for deciding *where* a place is likely to be before asking
// the Places API, and for rejecting an answer that lands somewhere implausible.
//
// The problem this exists to solve: a Takeout list CSV carries only a title and
// a Maps URL, so enrichment used to be a bare global text search for the title.
// "zondag" in a Tokyo list found a café in Groningen; "Santa Monica" in a Tokyo
// list found the city in California. Both are the top global match for that
// string, and both are wrong.

export interface Point {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;

// Great-circle distance in metres. Used both to size a search bias and to
// decide whether a returned place is too far away to be the one we asked for.
export function haversineMeters(a: Point, b: Point): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// How a bias derived from a region key is applied, by how many leading hex
// digits of the key the anchor and the query share.
//
// The key is Google's quadtree cell id (see `regionKeyFromMapsUrl`): opaque,
// but hierarchical, so a longer shared prefix means a smaller shared cell. The
// numbers below are deliberately generous — the cost of a bias that is too
// tight is a real place rejected, while a bias that is merely loose still rules
// out the failure this exists to prevent (a place in Japan resolving to one in
// the Netherlands).
interface Level {
  digits: number;
  biasMeters: number;
  maxMeters: number;
}

const LEVELS: Level[] = [
  { digits: 8, biasMeters: 10_000, maxMeters: 50_000 },
  { digits: 6, biasMeters: 25_000, maxMeters: 120_000 },
  { digits: 4, biasMeters: 75_000, maxMeters: 400_000 },
  // The coarsest level is advisory: it aims the search but rejects nothing.
  // Two shared digits is roughly "the same part of the world", and a window
  // wide enough to be fair to that is too wide to be evidence of an error —
  // measured against the real export it rejected a sushi bar in Hokkaido from
  // a list anchored around Tokyo, and Le Train Bleu from one around London.
  // Aiming the query still helps; refusing the answer does not.
  { digits: 2, biasMeters: 300_000, maxMeters: Infinity },
];

// What a lookup against the anchor set yields: where to bias the search, and
// how far from there an answer may still be believed.
export interface RegionBias {
  center: Point;
  biasMeters: number;
  maxMeters: number;
  // How many leading hex digits the anchor and the query shared. Zero means the
  // anchor is the whole list's centroid rather than a matching region.
  digits: number;
}

// The mean of a set of points. Adequate here because every anchor set is, by
// construction, places within one region — never a set spanning the antimeridian.
function centroid(points: Point[]): Point {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  return { lat, lng };
}

// Consensus
// ----------
// A list whose places carry no coordinates at all has nothing to aim its first
// lookup with, and aiming later lookups at the first one's answer would just
// propagate a wrong guess through the whole list. So the region is instead
// established by agreement: search everything unaimed, then ask where the
// answers *cluster*.
//
// This works because the two outcomes look nothing alike. A list of Tokyo
// places resolves mostly to Tokyo, with the failures scattered across whichever
// unrelated city happened to rank top for each name — right answers pile up in
// one place, wrong ones do not pile up anywhere. The pile is the region, and
// anything far from it is re-aimed.

// How close two answers must be to count as agreeing. Wide enough to hold a
// metropolitan area, far short of the continental errors being caught.
const CLUSTER_RADIUS_M = 75_000;

// The region precision consensus is computed at — roughly city scale. Coarser
// regions are reached by prefix fallback in `lookup` once these exist.
const CONSENSUS_DIGITS = 6;

// Below this many samples a "majority" is not evidence of anything.
const MIN_SAMPLES = 3;

export interface RegionSample {
  regionKey?: string;
  point: Point;
}

// Where each region's samples agree, for the regions that agree at all.
//
// Regions with too few samples, or whose samples scatter without a majority,
// yield nothing: no consensus means no rejections, which leaves those places
// exactly as well off as before rather than worse.
export function consensusCenters(
  samples: RegionSample[],
): Array<{ key: string; point: Point }> {
  const groups = new Map<string, Point[]>();
  for (const s of samples) {
    if (!s.regionKey) continue; // Ungrouped samples cannot vote on a region.
    const key = s.regionKey.slice(0, CONSENSUS_DIGITS);
    const bucket = groups.get(key);
    if (bucket) bucket.push(s.point);
    else groups.set(key, [s.point]);
  }

  const centers: Array<{ key: string; point: Point }> = [];
  for (const [key, points] of groups) {
    if (points.length < MIN_SAMPLES) continue;

    // The densest point wins: whichever answer has the most others near it.
    let best: Point[] = [];
    for (const candidate of points) {
      const near = points.filter(
        (p) => haversineMeters(candidate, p) <= CLUSTER_RADIUS_M,
      );
      if (near.length > best.length) best = near;
    }

    // A strict majority, so a region is only claimed when the answers actually
    // agree rather than merely being the largest of several scattered groups.
    if (best.length * 2 > points.length) {
      centers.push({ key, point: centroid(best) });
    }
  }
  return centers;
}

// An index of known positions, keyed by region, used to bias the lookups whose
// position is *not* known. Positions come only from sources that cost nothing
// and are trustworthy: coordinates carried by the export itself, and places
// this list has already resolved.
export class RegionAnchors {
  private readonly byRegion: Array<{ key: string; point: Point }> = [];

  // Record a known position. A place with no region key still counts toward the
  // whole-list fallback, which is the anchor of last resort.
  add(regionKey: string | undefined, point: Point): void {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return;
    this.byRegion.push({ key: regionKey ?? "", point });
  }

  get size(): number {
    return this.byRegion.length;
  }

  // The tightest bias available for a region: the longest prefix at which some
  // anchor agrees with this key.
  //
  // Deliberately no fallback to "somewhere in this list". A list is the user's
  // own grouping and says nothing geographic — "Want to go" holds 2784 places
  // on four continents, and its centroid is a point in the Pacific that would
  // reject most of the list as implausible. Only the region key, which comes
  // from the place's own feature id, is evidence about where a place is; with
  // no region in common with anything known, the honest answer is no bias at
  // all, which is exactly the unaimed search this had before.
  lookup(regionKey: string | undefined): RegionBias | undefined {
    if (!regionKey || this.byRegion.length === 0) return undefined;

    for (const level of LEVELS) {
      const prefix = regionKey.slice(0, level.digits);
      const hits = this.byRegion
        .filter((a) => a.key.startsWith(prefix))
        .map((a) => a.point);
      if (hits.length > 0) {
        return {
          center: centroid(hits),
          biasMeters: level.biasMeters,
          maxMeters: level.maxMeters,
          digits: level.digits,
        };
      }
    }
    return undefined;
  }
}
