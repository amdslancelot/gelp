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
    places.push({
      title,
      note: note === "" ? undefined : note,
      mapsUrl: url === "" ? undefined : url,
    });
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
