import { haversineMeters } from "./geo";

// A resolved place from the enrichment source.
export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  // The Places API (New) primaryType, e.g. "thai_restaurant".
  category: string;
  types: string[];
}

// The outcome of one lookup. "not found" and "the lookup failed" are kept
// apart on purpose: the first is an answer about the world and can be cached
// for a long time, the second says nothing about the place and must expire
// quickly so a blip is not baked in permanently.
//
// A search whose every candidate was rejected as implausibly far from where the
// place is known to be also reports "not found": the API answered, and nothing
// in the answer was the place we asked about.
export type PlaceLookup =
  | { status: "ok"; place: PlaceResult }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

// Where a lookup should be aimed, when the caller knows roughly where the place
// is. Without it a text search is a *global* search: the title of a Tokyo bar
// is matched against every business on earth, and the winner is whichever one
// Google ranks highest overall.
export interface SearchOptions {
  bias?: {
    lat: number;
    lng: number;
    // Radius of the circle the search is biased toward. A bias, not a fence:
    // the API may still return places outside it.
    biasMeters: number;
    // How far outside that circle an answer may be and still be believed. This
    // is the actual guard — the bias alone does not stop a distant match.
    maxMeters: number;
  };
}

// Abstraction over place enrichment so the import pipeline can be tested with
// a stub and never touches the network during build or self-check.
export interface PlacesClient {
  searchText(query: string, opts?: SearchOptions): Promise<PlaceLookup>;
}

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.location,places.primaryType,places.types,places.formattedAddress";

// Choose which of a search's results to believe.
//
// Without a bias this is the old behaviour: take the top-ranked result, because
// nothing better is known. With one, walk the results in rank order and take
// the first that is close enough to where the place is known to be — Google
// ranks by relevance to the *string*, so the right place is often present but
// not first. If none qualify, the honest answer is that we did not find it:
// leaving a place unpinned is recoverable, pinning it in the wrong country is
// what sent Tokyo restaurants to Europe.
export function selectCandidate(
  candidates: PlaceResult[],
  opts?: SearchOptions,
): PlaceResult | undefined {
  if (candidates.length === 0) return undefined;
  const bias = opts?.bias;
  if (!bias) return candidates[0];
  return candidates.find(
    (c) => haversineMeters(bias, { lat: c.lat, lng: c.lng }) <= bias.maxMeters,
  );
}

// Real client backed by the Google Places API (New).
export class GooglePlacesClient implements PlacesClient {
  constructor(private readonly apiKey: string) {}

  async searchText(query: string, opts?: SearchOptions): Promise<PlaceLookup> {
    const body: Record<string, unknown> = { textQuery: query };
    if (opts?.bias) {
      body.locationBias = {
        circle: {
          center: { latitude: opts.bias.lat, longitude: opts.bias.lng },
          // The API caps the bias radius at 50 km.
          radius: Math.min(50_000, Math.max(1, opts.bias.biasMeters)),
        },
      };
    }

    let res: Response;
    try {
      res = await fetch(SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // A network failure is contained here rather than thrown: one unreachable
      // place must not abort an import that has already emptied a list to
      // refill it, least of all in the unattended nightly sync.
      return { status: "unavailable", reason: `fetch failed: ${err}` };
    }

    if (!res.ok) return { status: "unavailable", reason: `HTTP ${res.status}` };

    const data = (await res.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        location?: { latitude?: number; longitude?: number };
        primaryType?: string;
        types?: string[];
      }>;
    };

    // Every candidate the search returned, in Google's rank order. Keeping more
    // than the first is what lets a bias pick the right one when the top match
    // is a better-known place that merely shares the name.
    const candidates: PlaceResult[] = (data.places ?? [])
      .filter(
        (p) =>
          typeof p.location?.latitude === "number" &&
          typeof p.location?.longitude === "number",
      )
      .map((p) => ({
        placeId: p.id ?? "",
        name: p.displayName?.text ?? "",
        address: p.formattedAddress ?? "",
        lat: p.location!.latitude!,
        lng: p.location!.longitude!,
        category: p.primaryType ?? "",
        types: p.types ?? [],
      }));

    const chosen = selectCandidate(candidates, opts);
    if (!chosen) return { status: "not_found" };
    return { status: "ok", place: chosen };
  }
}

// A client that resolves nothing. Used when no Places API key is configured,
// so imports still succeed with places left unenriched.
//
// It reports "unavailable", never "not found": nothing was asked of the API, so
// the resulting cache rows must expire quickly — otherwise importing before the
// key is configured would permanently mark every place as nonexistent.
export class NullPlacesClient implements PlacesClient {
  async searchText(): Promise<PlaceLookup> {
    return { status: "unavailable", reason: "no GOOGLE_MAPS_API_KEY configured" };
  }
}

// Build the appropriate client from the environment.
export function createPlacesClient(): PlacesClient {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  return key ? new GooglePlacesClient(key) : new NullPlacesClient();
}
