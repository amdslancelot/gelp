"use client";

import { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import {
  UNLOCATED_LIST_ID,
  unlocatedReason,
  type ListView,
  type PlaceView,
  type UnlocatedReason,
} from "@/lib/place-view";
import type { MapBounds } from "./MapView";
import { displayListName, humanizeCategory } from "@/lib/humanize";
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

export default function Browser({ lists }: { lists: ListView[] }) {
  const [selectedListId, setSelectedListId] = useState<string | null>(
    lists[0]?.id ?? null,
  );
  const [category, setCategory] = useState<string>(ALL);
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

  const selectedList = useMemo(
    () => lists.find((l) => l.id === selectedListId) ?? null,
    [lists, selectedListId],
  );

  // Distinct categories present in the selected list, for the chip row.
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const p of selectedList?.places ?? []) {
      if (p.category) set.add(p.category);
    }
    return Array.from(set).sort();
  }, [selectedList]);

  // Places mapped (all markers for the selected list), after category filtering.
  const visiblePlaces = useMemo(() => {
    const all = selectedList?.places ?? [];
    if (category === ALL) return all;
    return all.filter((p) => p.category === category);
  }, [selectedList, category]);

  // Places shown in the middle column: the mapped set, optionally narrowed to
  // the map's current viewport. Until the map reports its first bounds we show
  // everything, so the list is never empty on load.
  // The built-in "No coordinates" list is, by definition, nowhere on the map,
  // so narrowing it to the viewport would always empty it.
  const isUnlocated = selectedListId === UNLOCATED_LIST_ID;

  const listedPlaces = useMemo(() => {
    if (isUnlocated || !filterToView || !mapBounds) return visiblePlaces;
    return visiblePlaces.filter((p) => inBounds(p, mapBounds));
  }, [visiblePlaces, filterToView, mapBounds, isUnlocated]);

  const selectList = (id: string) => {
    setSelectedListId(id);
    setCategory(ALL);
    setFocus(null);
    setDrawerOpen(false);
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

      {/* Filter bar: spans the places-list and map columns above both. */}
      <div className="flex items-center gap-1.5 overflow-x-auto whitespace-nowrap border-b border-neutral-200 bg-white px-4 py-2.5 md:col-span-2">
        <Chip
          label="All"
          active={category === ALL}
          onClick={() => setCategory(ALL)}
        />
        {categories.map((c) => (
          <Chip
            key={c}
            label={humanizeCategory(c)}
            active={category === c}
            onClick={() => setCategory(c)}
          />
        ))}
        {/* Toggle: narrow the list to what's inside the current map viewport. */}
        <button
          onClick={() => setFilterToView((v) => !v)}
          aria-pressed={filterToView}
          className={`ml-auto shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition ${
            filterToView
              ? "border-rose-500 bg-rose-500 text-white"
              : "border-neutral-300 bg-white text-neutral-600 hover:bg-neutral-50"
          }`}
        >
          In map view
        </button>
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
          {listedPlaces.map((p) => {
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
                      p.category && (
                        <span className="shrink-0 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600">
                          {humanizeCategory(p.category)}
                        </span>
                      )
                    )}
                  </div>
                  {p.address && (
                    <div className="mt-0.5 text-xs text-neutral-500">
                      {p.address}
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
          {listedPlaces.length === 0 && (
            <li className="px-4 py-6 text-sm text-neutral-400">
              {filterToView && mapBounds && visiblePlaces.length > 0
                ? "No places in this area — zoom out or pan the map."
                : "No places to show."}
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
  lists: ListView[];
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
  active,
  onClick,
}: {
  label: string;
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
    </button>
  );
}
