// The shapes the UI renders, and the small amount of logic that reads them.
//
// Deliberately separate from `lib/queries`, which loads them: that module pulls
// in the Postgres driver, and a client component importing anything from it —
// even a constant — drags `pg` into the browser bundle, where it fails to
// resolve `fs`. Everything here is safe on both sides of that line.

// A place as presented to the UI.
export interface PlaceView {
  id: string;
  title: string;
  note: string | null;
  mapsUrl: string | null;
  address: string | null;
  category: string | null;
  // "permanently" or "temporarily" when the place's own map page said it has
  // shut. Worth surfacing because nothing else about the row differs: a closed
  // restaurant has the same title, address and pin as an open one.
  closed: "permanently" | "temporarily" | null;
  lat: number | null;
  lng: number | null;
  // Where the coordinates above came from, so the UI can say how much to trust
  // them — and, for a place with none, why it has none.
  //
  //   coords      — read off the place's own map page; correct
  //   url         — the export stated the position; correct
  //   search      — a text search picked it; a guess, and worth flagging
  //   not_a_place — a saved shopping item or link, never had a position
  //   null        — queued, or never resolved
  resolver: string | null;
  // The enrichment outcome, so the UI can tell a place nobody could find from
  // one whose lookup merely failed and will be retried.
  status: string | null;
  // True once this place is waiting on the resolve queue, so the UI can say so
  // rather than presenting it as simply missing.
  queued: boolean;
}

// A list as the sidebar shows it: named and counted, with no places attached.
// The places for whichever list is open are loaded on their own, because
// carrying all of them into every page load meant serialising every place in
// the account — thousands of them — to render one screenful.
export interface ListSummary {
  id: string;
  name: string;
  count: number;
}

// The id of the built-in list holding every place the account has a position
// for, across all of its lists. Like the unlocated list it is assembled rather
// than stored, so it has a reserved id: nothing in `lists` corresponds to it.
//
// Only placed places. A list called "All Places" that also carried the ones
// with no position would be the same set as every real list plus "No
// coordinates" — and the map, which is what this list is opened for, could
// show none of the difference. The unplaced ones already have a list of their
// own, and it is the one that can act on them.
export const ALL_PLACES_LIST_ID = "__all__";
export const ALL_PLACES_LIST_NAME = "All Places";

// The id of the built-in list of places with no position. Not a row in `lists`
// — it is assembled from whatever the real lists could not place, which is why
// it has a reserved id rather than a generated one.
export const UNLOCATED_LIST_ID = "__unlocated__";
export const UNLOCATED_LIST_NAME = "No coordinates";

// The id of the built-in list of places whose pin was chosen by searching the
// title, rather than read off the place's own map page. Assembled like the
// other two, so it too has a reserved id.
//
// These are the pins most likely to be wrong, and they are the ones hardest to
// notice: a guessed pin looks exactly like a correct one, and sits plausibly in
// the right city on a business with a similar name. The row already carries a
// "Guessed" badge, but only if the user happens to scroll past it — this list
// is the same set gathered somewhere it can be worked through.
//
// Above "No coordinates" because it is the milder problem of the two: a guessed
// place is on the map and merely might be wrong, while an unlocated one is not
// there at all.
export const GUESSED_LIST_ID = "__guessed__";
export const GUESSED_LIST_NAME = "Guessed";

// Why a place has no position, which decides what the user can do about it.
//
//   queued    — waiting for a resolve run; nothing to do but wait
//   retrying  — the lookup itself failed; it will be retried automatically
//   not_place — a saved shopping item or link; it never had a position
//   missing   — looked for and not found. This is the one worth flagging.
export type UnlocatedReason = "queued" | "retrying" | "not_place" | "missing";

export function unlocatedReason(p: PlaceView): UnlocatedReason {
  if (p.queued) return "queued";
  if (p.resolver === "not_a_place") return "not_place";
  if (p.status === "unavailable") return "retrying";
  return "missing";
}

// The place's page on Google Maps. The URL saved by Takeout is the real pin,
// so it is preferred; a coordinate search is the fallback for a place that was
// only ever located by the Places API. Null when there is neither — a saved
// shopping item, or one nothing could place.
//
// Kept here rather than in a component because both the map popup and the list
// row open the same place, and two builders would eventually disagree.
export function googleMapsUrlFor(place: PlaceView): string | null {
  if (place.mapsUrl) return place.mapsUrl;
  if (place.lat != null && place.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
  }
  return null;
}

// The same destination addressed to the Google Maps iOS app directly, via its
// URL scheme. Only iOS needs this: an https maps link is a universal link that
// Android hands to the app on its own, whereas Chrome on iOS keeps it and opens
// a web page — which is the whole thing this button exists to avoid.
//
// The place is named, not just located. Coordinates alone open the app on a
// dropped pin: the right spot, but no name, no hours, no reviews — not the
// place's own card. The scheme has no parameter that takes a place id or a CID,
// so the only way to ask for the place itself is to search its name; `center`
// pins that search to where we already know it is, so a chain with fifty
// branches resolves to this one, and a single match opens its card directly.
//
// Coordinates remain the fallback for a place with no usable title.
export function googleMapsAppUrlFor(place: PlaceView): string | null {
  const hasCoords = place.lat != null && place.lng != null;
  const title = place.title.trim();

  if (title) {
    const q = `q=${encodeURIComponent(title)}`;
    return hasCoords
      ? `comgooglemaps://?${q}&center=${place.lat},${place.lng}&zoom=17`
      : `comgooglemaps://?${q}`;
  }
  if (hasCoords) return `comgooglemaps://?q=${place.lat},${place.lng}`;
  return null;
}
