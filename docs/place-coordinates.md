# Where a place's position comes from

Gelp resolves the same question — *where is this place?* — by two completely
different routes, and keeps both. This is the reasoning, because it is not
recoverable from the code three months later.

## The problem

A Takeout "Saved" export identifies each place unambiguously and gives no
position. Every row carries a Maps URL like:

```
https://www.google.com/maps/place/x/data=!4m2!3m1!1s0x3442abd1000a41ff:0x59421b872a50dbbd
                                                    └── cell ──┘ └───── CID ─────┘
```

That `!1s0x<cell>:0x<cid>` is the **feature id**. The half after the colon is the
**CID**, Google's id for the place itself; the half before it is a geographic
quadtree cell. Google publishes no supported way to turn either into
coordinates, and the Data Portability API returns the same coordinate-less rows.

Verified against this repo's own export: of 4565 entries, **0** carry `!3d/!4d`
(a position) and **0** carry `@lat,lng` (a viewport). The export has ids and
nothing else.

## Route 1 — search by title (Places API)

`searchText` with the place's title. Runs on the server, in the deployed app,
during an import.

It is a **guess**: the API matches a name, it does not identify a place. A list
of Tokyo bars containing "zondag" matched a café in Groningen, because that is
the highest-ranked business on earth by that name. `lib/geo.ts` exists to
contain the damage — each lookup is biased toward the region its feature id's
cell prefix implies, and a candidate too far from that region is rejected rather
than pinned.

## Route 2 — open the place's own map page (`scripts/resolve-cids.py`)

A headless browser opens the URL from the export and reads the position out of
the URL the page settles on. It never searches for anything, so it cannot match
the wrong business. This is where `place_coords` rows come from.

It is not an API. It drives a browser against Google Maps, which Google's terms
do not permit, so it is a hand-run tool on a laptop over one person's own export
— never a server-side dependency. See the module docstring.

## Why both

| | search by title | open the map page |
|---|---|---|
| Needs a feature id | no | **yes** |
| Runs server-side, unattended | **yes** | no |
| Licensed | **yes** | no |
| Per place | ~100 ms, parallel | ~5 s, serial |
| Depends on | a documented, versioned API | undocumented URL and DOM shapes |
| Correct | usually | as far as observed, always |

The first row is the one that settles it. **19% of this repo's places have no
feature id** — 1015 of 5473 — so there is no page to open for them and search is
the only route that exists. 75 export entries have no URL at all, only a title.

The rest matter in production rather than in principle. The app runs in
Kubernetes; a server cannot launch a browser per place during an upload, which
is why `place_queue` exists and why draining it is a manual step. And a shared,
link-able app should not have a terms-of-service violation on its critical path.

Day to day the API is nearly idle anyway: `place_coords` answers first, a cached
answer never expires, and so a place costs at most one call ever. The API's
remaining job is the edges — places with no id, places whose id has died, and
new places between an import and the next resolve run.

## The tables

| Table | Holds | Expires |
|---|---|---|
| `place_coords` | positions read off each place's own map page, plus the address and category read from the same page | never |
| `place_cache` | whatever a lookup produced, by whichever route | only `unavailable`, after 6h |
| `place_queue` | places waiting to be read off their map page | closed when resolved |
| `tombstone_cid` | ids Google will not resolve any more | never |

Reads prefer `place_coords`:

```sql
coalesce(place_coords.lat, place_cache.lat)
```

so a correction is visible on the next page load rather than at the next import.
The address and category coalesce the same way, for the same reason — a pin
corrected to Bali under a San Francisco address reads as a bug in the map.

## Failure modes found the hard way

**The viewport is not the place.** A settled URL carries `!3d<lat>!4d<lng>` (the
place) and `@lat,lng` (the map viewport). They agree when the page resolves. When
it does not, the viewport is wherever the map opened by default — near whoever is
running the script. Falling back to it produced 110 places at one point,
identical to seven decimal places, a few miles from this laptop; Angkor Thom was
recorded in San Jose, and 105 of them overwrote a cached answer that had been
right. Only `!3d/!4d` counts now, and `scripts/load-resolved.ts` independently
refuses any batch where three or more places claim the same point.

**Some ids are dead.** Google is handed the feature id, finds nothing under it,
drops it from the URL and settles on a blank map. Retrying never helps, so those
CIDs go in `tombstone_cid` and are never queued again. What died is the id, not
usually the place — Angkor Thom is still there — so search by title is
deliberately *not* gated on it.

**A moved pin leaves a stale address.** When a search matched the wrong business,
its address, name and category are that other business's. Correcting only the
coordinates leaves the card describing somewhere else. `--details` reads the
address and category off the page alongside the position.

## Running the resolve loop

```bash
npm run db:up                                    # port-forward to the database
set -a; . ./.env; set +a                         # DATABASE_URL, quoting-safe

npx tsx scripts/dump-queue.ts                    # pending queue -> data/queue.jsonl
python3 scripts/resolve-cids.py --input data/queue.jsonl \
        --out data/place-coords.jsonl [--details]
npx tsx scripts/load-resolved.ts data/place-coords.jsonl          # dry run
npx tsx scripts/load-resolved.ts data/place-coords.jsonl --apply
```

The dry run is the point: it reports how many places move and how far, which
categories would be new to the filter list, and which batches it refuses. Read it
before `--apply`.

`--details` is off by default. The position comes from the URL and is sturdy; the
address and category come from the document and are not. A run without it leaves
those columns untouched rather than blanking them.
