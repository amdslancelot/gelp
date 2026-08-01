import AdmZip from "adm-zip";

// A single parsed place, independent of any storage concern.
export interface ParsedPlace {
  title: string;
  note?: string;
  mapsUrl?: string;
  address?: string;
  lat?: number;
  lng?: number;
}

// A named list of parsed places.
export interface ParsedList {
  name: string;
  places: ParsedPlace[];
}

// The full result of parsing a Takeout zip.
export interface ParsedTakeout {
  lists: ParsedList[];
}

// Parse a single RFC-4180 CSV document into rows of string fields. Handles
// quoted fields containing commas, embedded newlines, and escaped quotes.
export function parseCsv(input: string): string[][] {
  // Strip a leading UTF-8 byte-order mark if present.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // An escaped quote inside a quoted field.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // Normalise CRLF and lone CR into a single row break.
      if (text[i + 1] === "\n") i += 1;
      pushRow();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  // Flush the trailing field/row unless the input ended on a clean newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows;
}

// A Takeout list CSV gives no coordinates — but its `URL` column sometimes
// carries them anyway, in one of several shapes Google Maps uses. Mining them
// is worth the regexes: the result is the place's real position rather than a
// text search's best guess, and it costs no API call at all.
//
// Every shape puts latitude first.
const COORD_PATTERNS: RegExp[] = [
  // A dropped pin with no place attached: /maps/search/35.0266227,135.7391739
  /\/maps\/(?:search|place|dir)\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  // The viewport anchor in a full place URL: /@35.0266227,135.7391739,17z
  /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  // A query parameter: ?q=35.02,135.73, &ll=…, &center=…
  /[?&](?:q|ll|center|daddr)=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
  // The place's own position inside the protobuf-ish data blob.
  /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
];

// Extract a place's coordinates from its Maps URL, if the URL carries them.
export function coordsFromMapsUrl(
  url?: string,
): { lat: number; lng: number } | undefined {
  if (!url) return undefined;
  for (const pattern of COORD_PATTERNS) {
    const m = pattern.exec(url);
    if (!m) continue;
    const lat = Number(m[1]);
    const lng = Number(m[2]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    // Null Island is what a malformed URL degrades into, never a saved place.
    if (lat === 0 && lng === 0) continue;
    return { lat, lng };
  }
  return undefined;
}

// The region a place belongs to, taken from the feature id in a
// `data=!4m2!3m1!1s0x<cell>:0x<cid>` Maps URL.
//
// The first hex word is Google's quadtree cell for the place. We cannot decode
// it into coordinates, and do not try — but it is hierarchical, so two places
// whose cells share a leading prefix are in the same part of the world, and
// that is enough to keep a lookup on the right continent. Unlike anything the
// Places API returns, it comes from the export itself, so it is a fact about
// the saved place rather than a guess about it.
export function regionKeyFromMapsUrl(url?: string): string | undefined {
  const ftid = ftidFromMapsUrl(url);
  if (!ftid) return undefined;
  // Left-pad so prefixes of two keys are compared at the same magnitude; a
  // leading zero is dropped in the URL.
  return ftid.split(":")[0].replace(/^0x/, "").padStart(16, "0");
}

// The whole feature id from a Maps URL, normalised to `0x<cell>:0x<cid>`.
export function ftidFromMapsUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const m = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i.exec(url);
  return m ? m[1].toLowerCase() : undefined;
}

// Google's id for the place itself: the second half of the feature id.
//
// This is the stable half. The first half is a geographic cell, which can
// change if a business relocates, and the surrounding URL contains the place's
// name, which changes when it is renamed — so neither makes a durable key. The
// CID identifies the place and nothing else, which is why `place_coords` is
// keyed on it.
export function cidFromMapsUrl(url?: string): string | undefined {
  const ftid = ftidFromMapsUrl(url);
  if (ftid) return normaliseCid(ftid.split(":")[1]);

  // The other shape Google writes: `?cid=<decimal>`, which is what a Saved
  // Places.json entry and an older shared link both use. Normalising both to
  // the same hex means the same place matches whichever URL it arrived under.
  const m = /[?&]cid=(\d+)/.exec(url ?? "");
  if (!m) return undefined;
  try {
    return normaliseCid(BigInt(m[1]).toString(16));
  } catch {
    return undefined;
  }
}

// One place, one key: pad to a fixed width so however many leading zeros a URL
// happened to carry, the same place always produces the same string.
function normaliseCid(hex: string): string {
  return "0x" + hex.replace(/^0x/, "").toLowerCase().padStart(16, "0");
}

// Whether this entry is a place at all.
//
// A Takeout "Saved" list holds whatever the user starred, and not all of it is
// on a map: `google.com/shopping/product/…` items, saved films pointing at a
// bare `google.com`, ordinary web links. They have titles, so a text search
// will cheerfully return *something* for "Nike Flex Men's 8\" Training Shorts"
// — a shop, most likely, in whichever city ranked highest — and pin it. That is
// a billed API call spent to invent a place that was never saved.
//
// An entry with no URL at all is still searchable: a title on its own is all
// some exports give, and it is a real place.
export function isPlaceEntry(place: ParsedPlace): boolean {
  const url = place.mapsUrl?.trim();
  if (!url) return true;
  if (place.lat !== undefined && place.lng !== undefined) return true;
  return cidFromMapsUrl(url) !== undefined || coordsFromMapsUrl(url) !== undefined;
}

// Parse the CSV text of one Takeout list into places. The header is
// `Title,Note,URL` but exports vary, so columns are matched by name and extra
// columns (such as `Comment`) are tolerated.
function parseListCsv(text: string): ParsedPlace[] {
  const rows = parseCsv(text).filter(
    (r) => r.length > 0 && r.some((c) => c.trim() !== ""),
  );
  if (rows.length === 0) return [];

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const titleIdx = header.indexOf("title");
  const noteIdx = header.indexOf("note");
  const urlIdx = header.indexOf("url");

  // If there is no recognisable header, assume the classic column order.
  const resolvedTitle = titleIdx === -1 ? 0 : titleIdx;
  const resolvedNote = noteIdx === -1 ? 1 : noteIdx;
  const resolvedUrl = urlIdx === -1 ? 2 : urlIdx;
  const hasHeader = titleIdx !== -1;

  const dataRows = hasHeader ? rows.slice(1) : rows;
  const places: ParsedPlace[] = [];

  for (const cols of dataRows) {
    const title = (cols[resolvedTitle] ?? "").trim();
    if (title === "") continue;
    const note = (cols[resolvedNote] ?? "").trim();
    const url = (cols[resolvedUrl] ?? "").trim();
    const place: ParsedPlace = {
      title,
      note: note === "" ? undefined : note,
      mapsUrl: url === "" ? undefined : url,
    };
    const coords = coordsFromMapsUrl(place.mapsUrl);
    if (coords) {
      place.lat = coords.lat;
      place.lng = coords.lng;
    }
    places.push(place);
  }

  return places;
}

// Parse a Saved Places.json GeoJSON FeatureCollection into places, carrying
// through coordinates when the geometry provides them.
function parseSavedPlacesJson(text: string): ParsedPlace[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let data: unknown;
  try {
    data = JSON.parse(clean);
  } catch {
    return [];
  }

  const features =
    data && typeof data === "object" && Array.isArray((data as any).features)
      ? ((data as any).features as any[])
      : [];

  const places: ParsedPlace[] = [];
  for (const feature of features) {
    const props = feature?.properties ?? {};
    const location = props.location ?? {};
    const title = (location.name ?? props.name ?? "").toString().trim();
    if (title === "") continue;

    const place: ParsedPlace = { title };
    const address = (location.address ?? "").toString().trim();
    if (address !== "") place.address = address;
    const mapsUrl = (props.google_maps_url ?? "").toString().trim();
    if (mapsUrl !== "") place.mapsUrl = mapsUrl;

    const coords = feature?.geometry?.coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      // GeoJSON stores coordinates as [longitude, latitude].
      const lng = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        place.lat = lat;
        place.lng = lng;
      }
    }
    if (place.lat === undefined) {
      // A feature with no geometry can still name its position in the URL.
      const fallback = coordsFromMapsUrl(place.mapsUrl);
      if (fallback) {
        place.lat = fallback.lat;
        place.lng = fallback.lng;
      }
    }

    places.push(place);
  }

  return places;
}

// Derive a human-friendly list name from a CSV entry path.
function listNameFromPath(entryName: string): string {
  const base = entryName.split("/").pop() ?? entryName;
  return base.replace(/\.csv$/i, "");
}

// Decide whether a zip entry looks like a Takeout list CSV. Matches any CSV
// under a `Saved`-like folder, tolerating localized or absent prefixes, and
// falls back to top-level CSVs.
function isSavedCsv(entryName: string): boolean {
  if (!/\.csv$/i.test(entryName)) return false;
  const lower = entryName.toLowerCase();
  const segments = lower.split("/");
  // A CSV directly under a folder whose name contains "saved".
  if (segments.some((s) => s.includes("saved"))) return true;
  // A top-level CSV with no folder nesting.
  return !entryName.includes("/");
}

// Parse a Takeout zip buffer into lists of places. Pure: no DB, no network.
export function parseTakeoutZip(buf: Buffer): ParsedTakeout {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);

  const lists: ParsedList[] = [];

  for (const entry of entries) {
    if (isSavedCsv(entry.entryName)) {
      const text = entry.getData().toString("utf8");
      const places = parseListCsv(text);
      if (places.length > 0) {
        lists.push({ name: listNameFromPath(entry.entryName), places });
      }
    }
  }

  // Locate the Saved Places.json anywhere in the archive.
  const savedJson = entries.find((e) =>
    /saved places\.json$/i.test(e.entryName),
  );
  if (savedJson) {
    const places = parseSavedPlacesJson(savedJson.getData().toString("utf8"));
    if (places.length > 0) {
      lists.push({ name: "Saved Places", places });
    }
  }

  return { lists };
}
