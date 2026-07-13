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

// Abstraction over place enrichment so the import pipeline can be tested with
// a stub and never touches the network during build or self-check.
export interface PlacesClient {
  searchText(query: string): Promise<PlaceResult | null>;
}

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const FIELD_MASK =
  "places.id,places.displayName,places.location,places.primaryType,places.types,places.formattedAddress";

// Real client backed by the Google Places API (New).
export class GooglePlacesClient implements PlacesClient {
  constructor(private readonly apiKey: string) {}

  async searchText(query: string): Promise<PlaceResult | null> {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": this.apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify({ textQuery: query }),
    });

    if (!res.ok) return null;

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
    if (!first) return null;

    return {
      placeId: first.id ?? "",
      name: first.displayName?.text ?? "",
      address: first.formattedAddress ?? "",
      lat: first.location?.latitude ?? 0,
      lng: first.location?.longitude ?? 0,
      category: first.primaryType ?? "",
      types: first.types ?? [],
    };
  }
}

// A client that resolves nothing. Used when no Places API key is configured,
// so imports still succeed with places left unenriched.
export class NullPlacesClient implements PlacesClient {
  async searchText(): Promise<PlaceResult | null> {
    return null;
  }
}

// Build the appropriate client from the environment.
export function createPlacesClient(): PlacesClient {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  return key ? new GooglePlacesClient(key) : new NullPlacesClient();
}
