"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  UNLOCATED_LIST_ID,
  unlocatedReason,
  type ListSummary,
  type PlaceView,
  type UnlocatedReason,
} from "@/lib/place-view";
import type { MapBounds } from "./MapView";
import { displayListName, humanizeCategory } from "@/lib/humanize";
import { tier1Of } from "@/lib/category-tree";
import FlagButton from "./FlagButton";

// What each reason for having no position looks like, and whether the user can
// do anything about it. Only "missing" is actionable: the rest are either
// already in hand or were never places to begin with.
const REASONS: Record<
  UnlocatedReason,
  { label: string; tone: string; flaggable: boolean }
> = {
  missing: {
    label: "Couldn't find it",
    tone: "bg-amber-100 text-amber-800",
    flaggable: true,
  },
  queued: {
    label: "Queued",
    tone: "bg-sky-100 text-sky-800",
    flaggable: false,
  },
  retrying: {
    label: "Will retry",
    tone: "bg-neutral-100 text-neutral-600",
    flaggable: false,
  },
  not_place: {
    label: "Not a place",
    tone: "bg-neutral-100 text-neutral-500",
    flaggable: false,
  },
};

// Leaflet touches `window`, so the map is loaded only on the client.
const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-neutral-400">
      Loading map…
    </div>
  ),
});

// A special filter value meaning "no category filter applied".
const ALL = "__all__";

// The umbrella for places carrying no category at all. It exists so that every
// place in a list is reachable from some chip: without it the uncategorised
// ones are visible only under "All", which is also why "All" used to read a
// larger number than every other chip added up.
//
// A sentinel rather than a real tree entry, because "uncategorised" is the
// absence of the thing the tree is about — it can never gain leaves, and
// `tier1Of` must never return it.
const NONE = "__none__";

// How many rows the middle column draws before it stops and offers the rest on
// request. The largest list here holds 2788 places, and rendering all of them
// costs about 1.2 MB of server-rendered HTML that the browser then has to
// hydrate — for a list nobody scrolls to the end of. Worse, on load it is
// rendered before the map has reported a viewport, so within a few hundred
// milliseconds all but a screenful are thrown away again.
const ROWS_BEFORE_MORE = 100;

// True when a place's coordinates fall inside the map's current viewport. The
// longitude test tolerates a viewport that straddles the antimeridian (where
// west > east). Places without coordinates aren't on the map, so they're out.
function inBounds(p: PlaceView, b: MapBounds): boolean {
  if (p.lat == null || p.lng == null) return false;
  const latOk = p.lat >= b.south && p.lat <= b.north;
  const lngOk =
    b.west <= b.east
      ? p.lng >= b.west && p.lng <= b.east
      : p.lng >= b.west || p.lng <= b.east;
  return latOk && lngOk;
}

export default function Browser({
  lists,
  initialPlaces,
  placesUrl,
}: {
  lists: ListSummary[];
  // The places of the list that opens first, rendered with the page so the
  // first screen costs no round trip.
  initialPlaces: PlaceView[];
  // Where to fetch another list's places, with `{id}` standing in for the list.
  // A template rather than a fixed path because a shared map reads through a
  // token-authorised route rather than the session one.
  placesUrl: string;
}) {
  const firstListId = lists[0]?.id ?? null;
  const [selectedListId, setSelectedListId] = useState<string | null>(
    firstListId,
  );
  // Places are kept per list, so going back to one already opened is instant
  // and costs no second request.
  const [placesByList, setPlacesByList] = useState<Record<string, PlaceView[]>>(
    () => (firstListId ? { [firstListId]: initialPlaces } : {}),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped by Retry, so a failed load can be asked for again without changing
  // anything else the fetch depends on.
  const [reloadTick, setReloadTick] = useState(0);

  const places = selectedListId ? placesByList[selectedListId] : undefined;
  const loading = selectedListId !== null && places === undefined && !loadError;

  // The filter is two-tier: an umbrella, then optionally one category under it.
  // `leaf` is null while the whole umbrella is selected, and is always inside
  // `umbrella` — picking a new umbrella clears it.
  const [umbrella, setUmbrella] = useState<string>(ALL);
  const [leaf, setLeaf] = useState<string | null>(null);
  const [focus, setFocus] = useState<PlaceView | null>(null);
  // When on, the middle-column list is narrowed to places inside the map's
  // current viewport. `mapBounds` is the latest viewport reported by the map.
  const [filterToView, setFilterToView] = useState(true);
  const [mapBounds, setMapBounds] = useState<MapBounds | null>(null);
  // Stable so MapView's bounds subscription isn't torn down on every render.
  const handleBoundsChange = useCallback(
    (b: MapBounds) => setMapBounds(b),
    [],
  );
  // Mobile-only view state: which pane is showing, and whether the lists drawer
  // is open. Both are inert at md+ where all three columns are visible at once.
  const [mobileTab, setMobileTab] = useState<"list" | "map">("list");
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Set once the user asks for the rows past ROWS_BEFORE_MORE. Cleared whenever
  // the list or the filter changes, because that is a different set of places
  // and the request was about the old one.
  const [showAllRows, setShowAllRows] = useState(false);

  // Fetch the selected list's places the first time it is opened. Everything
  // else on the page reads `places`, so this is the only thing that knows the
  // places arrive separately from the list they belong to.
  useEffect(() => {
    if (!selectedListId || placesByList[selectedListId]) return;
    const controller = new AbortController();
    setLoadError(null);
    fetch(placesUrl.replace("{id}", encodeURIComponent(selectedListId)), {
      signal: controller.signal,
    })
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((body: { places: PlaceView[] }) =>
        setPlacesByList((byList) => ({
          ...byList,
          [selectedListId]: body.places,
        })),
      )
      .catch((err: Error) => {
        // An abort is this component moving on, not a failure to report.
        if (err.name !== "AbortError") setLoadError("Couldn't load this list.");
      });
    return () => controller.abort();
  }, [selectedListId, placesByList, placesUrl, reloadTick]);

  const selectedList = useMemo(
    () => lists.find((l) => l.id === selectedListId) ?? null,
    [lists, selectedListId],
  );

  // The built-in "No coordinates" list is, by definition, nowhere on the map,
  // so narrowing it to the viewport would always empty it.
  const isUnlocated = selectedListId === UNLOCATED_LIST_ID;

  // The selected list narrowed to the map's current viewport — the set the user
  // can actually see. Until the map reports its first bounds this is everything,
  // so nothing is ever empty on load. Category filtering is deliberately not
  // applied here: the chips count off this set, and a chip has to keep counting
  // its own category even while a different one is selected.
  const boundedPlaces = useMemo(() => {
    const all = places ?? [];
    if (isUnlocated || !filterToView || !mapBounds) return all;
    return all.filter((p) => inBounds(p, mapBounds));
  }, [places, filterToView, mapBounds, isUnlocated]);

  // How many places each umbrella and each category has inside the viewport.
  // This is what the chips display, so their numbers and the list below them
  // are always the same claim about the same places.
  const inView = useMemo(() => {
    const byUmbrella = new Map<string, number>();
    const byCategory = new Map<string, number>();
    for (const p of boundedPlaces) {
      if (!p.category) {
        byUmbrella.set(NONE, (byUmbrella.get(NONE) ?? 0) + 1);
        continue;
      }
      const t = tier1Of(p.category);
      byUmbrella.set(t, (byUmbrella.get(t) ?? 0) + 1);
      byCategory.set(p.category, (byCategory.get(p.category) ?? 0) + 1);
    }
    return { byUmbrella, byCategory };
  }, [boundedPlaces]);

  // The umbrellas present in the selected list, biggest first. A list of 200
  // places can carry 60 categories, which is not a row anyone reads; the
  // umbrella is what makes the first choice small enough to scan.
  // Which chips exist, and their order, come from the whole list rather than
  // the viewport: a row that reshuffles under the thumb on every pan can't be
  // aimed at, and a chip that vanishes takes away the way back to its places.
  // Only the number on each chip follows the map.
  const umbrellas = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of places ?? []) {
      const t = p.category ? tier1Of(p.category) : NONE;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    // Uncategorised last whatever its size. It is currently the biggest bucket
    // in most lists, and sorted by count it would take the first chip — putting
    // the one group that says nothing about a place ahead of every group that
    // does. It is a way back to those places, not a category.
    return Array.from(counts).sort(
      (a, b) =>
        Number(a[0] === NONE) - Number(b[0] === NONE) ||
        b[1] - a[1] ||
        a[0].localeCompare(b[0]),
    );
  }, [places]);

  // The categories under the chosen umbrella that this list actually has. One
  // of them means the umbrella is already as narrow as the data goes, so the
  // second row would just repeat the first and is not drawn.
  const leaves = useMemo(() => {
    if (umbrella === ALL) return [];
    const counts = new Map<string, number>();
    for (const p of places ?? []) {
      if (p.category && tier1Of(p.category) === umbrella) {
        counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
      }
    }
    return Array.from(counts).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }, [places, umbrella]);

  // Places mapped (all markers for the selected list), after category filtering.
  // Never narrowed to the viewport: the markers are what defines the viewport,
  // and feeding the map's own bounds back into its markers would have it re-fit
  // to an ever-smaller set.
  const visiblePlaces = useMemo(() => {
    const all = places ?? [];
    if (umbrella === ALL) return all;
    if (umbrella === NONE) return all.filter((p) => !p.category);
    if (leaf) return all.filter((p) => p.category === leaf);
    return all.filter((p) => p.category && tier1Of(p.category) === umbrella);
  }, [places, umbrella, leaf]);

  // Places shown in the middle column: what's in view, then the category filter.
  const listedPlaces = useMemo(() => {
    if (umbrella === ALL) return boundedPlaces;
    if (umbrella === NONE) return boundedPlaces.filter((p) => !p.category);
    if (leaf) return boundedPlaces.filter((p) => p.category === leaf);
    return boundedPlaces.filter(
      (p) => p.category && tier1Of(p.category) === umbrella,
    );
  }, [boundedPlaces, umbrella, leaf]);

  // What actually reaches the DOM, and how much was held back.
  const shownPlaces = useMemo(
    () => (showAllRows ? listedPlaces : listedPlaces.slice(0, ROWS_BEFORE_MORE)),
    [listedPlaces, showAllRows],
  );
  const heldBack = listedPlaces.length - shownPlaces.length;

  const selectUmbrella = (t: string) => {
    setUmbrella(t);
    setLeaf(null);
    setShowAllRows(false);
  };

  const selectList = (id: string) => {
    setSelectedListId(id);
    selectUmbrella(ALL);
    setFocus(null);
    setDrawerOpen(false);
    setShowAllRows(false);
    // Drop the stale viewport so the new list shows all its places immediately;
    // the map re-fits to the new markers and reports fresh bounds a beat later.
    setMapBounds(null);
  };

  // Tapping a place focuses it and, on mobile, flips to the map so the pin is
  // visible without a second tap. On desktop the map is always on screen.
  const selectPlace = (p: PlaceView) => {
    setFocus(p);
    setMobileTab("map");
  };

  return (
    <div className="relative flex flex-1 flex-col overflow-hidden md:grid md:grid-cols-[240px_minmax(0,1fr)_minmax(0,1.2fr)] md:grid-rows-[auto_1fr]">
      {/* Mobile control bar: list picker + list/map toggle. Hidden at md+. */}
      <div className="flex items-center gap-2 border-b border-neutral-200 bg-white px-3 py-2 md:hidden">
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex min-w-0 items-center gap-1.5 rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700"
        >
          <span className="truncate">
            {selectedList ? displayListName(selectedList.name) : "Lists"}
          </span>
          <span className="shrink-0 text-neutral-400">▾</span>
        </button>
        <div className="ml-auto flex shrink-0 rounded-lg border border-neutral-300 p-0.5 text-xs font-medium">
          <button
            onClick={() => setMobileTab("list")}
            className={`rounded-md px-3 py-1 ${
              mobileTab === "list"
                ? "bg-rose-500 text-white"
                : "text-neutral-600"
            }`}
          >
            List
          </button>
          <button
            onClick={() => setMobileTab("map")}
            className={`rounded-md px-3 py-1 ${
              mobileTab === "map" ? "bg-rose-500 text-white" : "text-neutral-600"
            }`}
          >
            Map
          </button>
        </div>
      </div>

      {/* Left column (desktop): the user's lists. */}
      <aside className="row-span-2 hidden overflow-y-auto border-r border-neutral-200 bg-white md:block">
        <h2 className="px-4 py-3 text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Lists
        </h2>
        <ListItems
          lists={lists}
          selectedListId={selectedListId}
          onSelect={selectList}
        />
      </aside>

      {/* Filter bar: spans the places-list and map columns above both. Two rows,
          the second only once an umbrella with more than one category under it
          is chosen. */}
      <div className="border-b border-neutral-200 bg-white md:col-span-2">
        <div className="flex items-center px-4 py-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto whitespace-nowrap">
            {/* Counted off `boundedPlaces` rather than the per-category
                tallies, because "All" includes the places carrying no category
                at all — and it has to agree with the list, which shows them. */}
            <Chip
              label="All"
              count={boundedPlaces.length}
              active={umbrella === ALL}
              onClick={() => selectUmbrella(ALL)}
            />
            {umbrellas.map(([t]) => (
              <Chip
                key={t}
                label={t === NONE ? "Uncategorized" : humanizeCategory(t)}
                count={inView.byUmbrella.get(t) ?? 0}
                active={umbrella === t}
                onClick={() => selectUmbrella(t)}
              />
            ))}
          </div>
          {/* Toggle: narrow the list to what's inside the current map viewport.
              It sits outside the scrolling chip row on purpose — inside it, a
              list with sixty categories pushed the control that explains an
              empty list off the right edge of every phone. */}
          <button
            onClick={() => setFilterToView((v) => !v)}
            aria-pressed={filterToView}
            className={`ml-2 shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
              filterToView
                ? "border-rose-500 bg-rose-500 text-white"
                : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50"
            }`}
          >
            In map view
          </button>
        </div>
        {leaves.length > 1 && (
          <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap border-t border-neutral-100 bg-neutral-50 px-4 py-2">
            <Chip
              label={`All ${humanizeCategory(umbrella)}`}
              count={inView.byUmbrella.get(umbrella) ?? 0}
              active={leaf === null}
              onClick={() => setLeaf(null)}
            />
            {leaves.map(([c]) => (
              <Chip
                key={c}
                label={humanizeCategory(c)}
                count={inView.byCategory.get(c) ?? 0}
                active={leaf === c}
                onClick={() => {
                  setLeaf(c);
                  setShowAllRows(false);
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Middle column: places in the selected list. On mobile it shares the
          viewport with the map and is toggled by the tab bar. */}
      <section
        className={`flex-1 flex-col overflow-hidden md:flex ${
          mobileTab === "map" ? "hidden" : "flex"
        }`}
      >
        {isUnlocated && (
          <p className="border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-800">
            These places have no position, so they are on no map. The ones
            marked <span className="font-medium">Couldn&rsquo;t find it</span> can
            be queued to have their real coordinates read from Google Maps.
          </p>
        )}
        <ul className="flex-1 overflow-y-auto divide-y divide-neutral-100">
          {shownPlaces.map((p) => {
            const reason = REASONS[unlocatedReason(p)];
            const unplaced = p.lat === null || p.lng === null;
            return (
              <li key={p.id} className="relative">
                <button
                  onClick={() => selectPlace(p)}
                  className={`block w-full px-4 py-3 text-left hover:bg-neutral-50 ${
                    focus?.id === p.id ? "bg-neutral-50" : ""
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-neutral-900">
                      {p.title}
                    </span>
                    {unplaced ? (
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${reason.tone}`}
                      >
                        {reason.label}
                      </span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1">
                        {/* This pin was chosen by searching the title, not read
                            off the place's own map page — so it may be a
                            different business with a similar name. Said on the
                            row rather than left to the map, because a pin gives
                            no sign of how it was found, and this is the row
                            whose Report button is worth pressing. */}
                        {p.resolver === "search" && (
                          <span
                            title="Position guessed by searching the name — it may be the wrong business."
                            className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700"
                          >
                            Guessed
                          </span>
                        )}
                        {p.category && (
                          <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
                            {humanizeCategory(p.category)}
                          </span>
                        )}
                      </span>
                    )}
                  </div>
                  {p.address && (
                    <div className="mt-0.5 text-xs text-neutral-500">
                      {p.address}
                    </div>
                  )}
                  {/* A closed place keeps its pin, because it is still where it
                      was and the list is a record of what was saved. Saying so
                      is the whole fix: nothing else about the row differs. */}
                  {p.closed && (
                    <div className="mt-0.5 text-xs font-medium text-rose-600">
                      {p.closed === "permanently"
                        ? "Permanently closed"
                        : "Temporarily closed"}
                    </div>
                  )}
                  {p.note && (
                    <div className="mt-1 text-sm text-neutral-600">{p.note}</div>
                  )}
                </button>
                {/* Offered where it can actually help: on a pin that exists but
                    may be wrong, and on a place nothing could locate. Never on
                    a saved shirt, or on one already queued. */}
                {((unplaced && reason.flaggable) ||
                  (!unplaced && p.resolver === "search")) && (
                  <div className="pointer-events-none absolute bottom-2 right-3">
                    <FlagButton
                      mapsUrl={p.mapsUrl}
                      title={p.title}
                      className="pointer-events-auto"
                    />
                  </div>
                )}
              </li>
            );
          })}
          {loading && (
            <li className="px-4 py-6 text-sm text-neutral-400">Loading…</li>
          )}
          {loadError && (
            <li className="px-4 py-6 text-sm text-neutral-500">
              {loadError}{" "}
              <button
                onClick={() => {
                  setLoadError(null);
                  setReloadTick((t) => t + 1);
                }}
                className="font-medium text-rose-600 underline"
              >
                Retry
              </button>
            </li>
          )}
          {!loading && !loadError && listedPlaces.length === 0 && (
            <li className="px-4 py-6 text-sm text-neutral-400">
              {filterToView && mapBounds && visiblePlaces.length > 0
                ? "No places in this area — zoom out or pan the map."
                : "No places to show."}
            </li>
          )}
          {/* Says how many rows are being withheld rather than ending the list
              silently, which would read as "that's all of them". */}
          {heldBack > 0 && (
            <li className="px-4 py-4">
              <button
                onClick={() => setShowAllRows(true)}
                className="w-full rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
              >
                Show {heldBack} more
              </button>
            </li>
          )}
        </ul>
      </section>

      {/* Right column: the map. */}
      <section
        className={`relative flex-1 border-neutral-200 md:block md:border-l ${
          mobileTab === "list" ? "hidden" : "block"
        }`}
      >
        <MapView
          places={visiblePlaces}
          focus={focus}
          onBoundsChange={handleBoundsChange}
        />
      </section>

      {/* Mobile lists drawer. */}
      {drawerOpen && (
        <div className="fixed inset-0 z-[2000] md:hidden">
          <button
            aria-label="Close lists"
            onClick={() => setDrawerOpen(false)}
            className="absolute inset-0 bg-black/30"
          />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[80%] flex-col overflow-y-auto bg-white shadow-xl">
            <div className="flex items-center justify-between px-4 py-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                Lists
              </h2>
              <button
                onClick={() => setDrawerOpen(false)}
                className="text-sm text-neutral-400"
              >
                ✕
              </button>
            </div>
            <ListItems
              lists={lists}
              selectedListId={selectedListId}
              onSelect={selectList}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

// The list-of-lists navigation, shared by the desktop sidebar and the mobile
// drawer.
function ListItems({
  lists,
  selectedListId,
  onSelect,
}: {
  lists: ListSummary[];
  selectedListId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="pb-4">
      {lists.map((list) => {
        // The built-in list of places with no position. Marked out because it
        // is not one of the user's own lists and is a to-do, not a place to
        // browse — it should read as something to deal with.
        const built = list.id === UNLOCATED_LIST_ID;
        const selected = list.id === selectedListId;
        return (
          <li key={list.id} className={built ? "mt-2 border-t border-neutral-200 pt-2" : ""}>
            <button
              onClick={() => onSelect(list.id)}
              className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                selected
                  ? built
                    ? "bg-amber-50 font-medium text-amber-800"
                    : "bg-rose-50 font-medium text-rose-700"
                  : built
                    ? "text-amber-700 hover:bg-amber-50"
                    : "text-neutral-700 hover:bg-neutral-50"
              }`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {built && <span aria-hidden>⚠</span>}
                <span className="truncate">{displayListName(list.name)}</span>
              </span>
              <span
                className={`ml-2 shrink-0 text-xs ${
                  built ? "text-amber-600" : "text-neutral-400"
                }`}
              >
                {list.count}
              </span>
            </button>
          </li>
        );
      })}
      {lists.length === 0 && (
        <li className="px-4 py-2 text-sm text-neutral-400">
          No lists yet. Import a Takeout export.
        </li>
      )}
    </ul>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? "border-rose-500 bg-rose-500 text-white"
          : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50"
      }`}
    >
      {label}
      {count !== undefined && (
        <span className={active ? "ml-1.5 text-rose-100" : "ml-1.5 text-neutral-400"}>
          {count}
        </span>
      )}
    </button>
  );
}
