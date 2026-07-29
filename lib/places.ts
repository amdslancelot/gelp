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
export type PlaceLookup =
  | { status: "ok"; place: PlaceResult }
  | { status: "not_found" }
  | { status: "unavailable"; reason: string };

// Abstraction over place enrichment so the import pipeline can be tested with
// a stub and never touches the network during build or self-check.
export interface PlacesClient {
  searchText(query: string): Promise<PlaceLookup>;
}

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.location,places.primaryType,places.types,places.formattedAddress";

// Real client backed by the Google Places API (New).
export class GooglePlacesClient implements PlacesClient {
  constructor(private readonly apiKey: string) {}

  async searchText(query: string): Promise<PlaceLookup> {
    let res: Response;
    try {
      res = await fetch(SEARCH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": this.apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify({ textQuery: query }),
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

    const first = data.places?.[0];
    if (!first) return { status: "not_found" };

    return {
      status: "ok",
      place: {
        placeId: first.id ?? "",
        name: first.displayName?.text ?? "",
        address: first.formattedAddress ?? "",
        lat: first.location?.latitude ?? 0,
        lng: first.location?.longitude ?? 0,
        category: first.primaryType ?? "",
        types: first.types ?? [],
      },
    };
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
