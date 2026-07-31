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

// A list plus its resolved places and a place count.
export interface ListView {
  id: string;
  name: string;
  count: number;
  places: PlaceView[];
}

// The id of the built-in list of places with no position. Not a row in `lists`
// — it is assembled from whatever the real lists could not place, which is why
// it has a reserved id rather than a generated one.
export const UNLOCATED_LIST_ID = "__unlocated__";
export const UNLOCATED_LIST_NAME = "No coordinates";

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
