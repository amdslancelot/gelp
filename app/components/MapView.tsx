"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import "leaflet/dist/leaflet.css";
// The cluster package ships its stylesheets but does not import them itself;
// without these the cluster bubbles render as unstyled blocks.
import "react-leaflet-cluster/dist/assets/MarkerCluster.css";
import "react-leaflet-cluster/dist/assets/MarkerCluster.Default.css";
import type { PlaceView } from "@/lib/queries";
import type { MyLocation } from "./use-my-location";

// The map's current viewport, reported to the parent as plain numbers so the
// list can be filtered to what's on screen without leaking Leaflet types out.
export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

// Fix Leaflet's default marker icons, whose relative URLs break under bundlers.
// Served from `public/leaflet/` (copied from the leaflet package) rather than a
// CDN: whether this map has pins on it should not depend on a third party being
// up, and it is one less connection for a phone to open before anything shows.
const icon = L.icon({
  iconUrl: "/leaflet/marker-icon.png",
  iconRetinaUrl: "/leaflet/marker-icon-2x.png",
  shadowUrl: "/leaflet/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface MapViewProps {
  places: PlaceView[];
  // The place to pan/zoom to, if any.
  focus: PlaceView | null;
  // Called whenever the viewport settles (pan/zoom end), so the parent can
  // narrow the list to places within view. Optional.
  onBoundsChange?: (bounds: MapBounds) => void;
  // What the current framing is *for* — the list and category filter being
  // shown. The map re-frames when this changes and not merely when `places`
  // does, because places also changes when the rest of a list arrives behind
  // the near-me set, and re-fitting there would yank the map from the street
  // the user is standing on out to the whole world.
  frameKey: string;
  // Where the user is. Owned by the parent because the first fetch is aimed at
  // it — see `use-my-location`.
  location: MyLocation;
}

// The saved Takeout URL is the real Google Maps pin; fall back to a
// coordinate search when a place was only resolved via the Places API.
function googleMapsUrlFor(place: PlaceView): string | null {
  if (place.mapsUrl) return place.mapsUrl;
  if (place.lat != null && place.lng != null) {
    return `https://www.google.com/maps/search/?api=1&query=${place.lat},${place.lng}`;
  }
  return null;
}

// Keep the map framed to the visible markers, and pan to a focused place.
// Framing is deferred until the container has a real size: on mobile the map
// lives in a display:none pane until the Map tab is shown, and everything
// Leaflet derives from a 0×0 container — the zoom that fits a set of points,
// the visible bounds — is arithmetic on nothing. What it produces there is not
// merely imprecise; a zero width makes the fit fall back to the tile layer's
// max zoom over a center that ignores the aspect ratio it was never given.
function MapController({
  places,
  focus,
  visible,
  frameKey,
}: {
  places: PlaceView[];
  focus: PlaceView | null;
  visible: boolean;
  frameKey: string;
}) {
  const map = useMap();
  // What the map was last framed for. A pane being revealed is not a reason to
  // re-frame — that would throw away the pan the user made before they left it.
  // Only a change of `frameKey` — the list being shown — or of focus is, so a
  // reveal re-frames exactly when the change arrived while the pane was hidden
  // and could not be acted on. Filtering the places within a list deliberately
  // does not re-frame: the user is asking which of what they can see matches,
  // not to be flown to the matches' global extent.
  const framedFor = useRef<{
    frameKey: string;
    focus: PlaceView | null;
    // How many places that framing had to work with. Zero means it framed
    // nothing at all — the user is nowhere near this list, and the near-me
    // fetch came back empty — so the arrival of the rest is the first real
    // chance to frame and must be taken.
    count: number;
  }>(null);

  useEffect(() => {
    if (!visible) return;
    // Re-measure: the pane may have just been revealed, and Leaflet still holds
    // the size it had while hidden.
    map.invalidateSize();
    if (
      framedFor.current?.frameKey === frameKey &&
      framedFor.current?.focus === focus &&
      framedFor.current.count > 0
    ) {
      return;
    }
    framedFor.current = { frameKey, focus, count: places.length };
    if (focus && Number.isFinite(focus.lat) && Number.isFinite(focus.lng)) {
      map.flyTo([focus.lat as number, focus.lng as number], 16, {
        duration: 0.6,
      });
      return;
    }
    const withCoords = places.filter(
      (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng),
    );
    if (withCoords.length === 0) return;
    const bounds = L.latLngBounds(
      withCoords.map((p) => [p.lat as number, p.lng as number]),
    );
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [map, places, focus, visible, frameKey]);

  return null;
}

// Report the visible bounds to the parent whenever the viewport settles.
// `moveend` fires after both pans and zooms (and after the initial fitBounds),
// so it's the single signal we need. The parent uses it to filter the list.
function BoundsReporter({
  onBoundsChange,
}: {
  onBoundsChange?: (bounds: MapBounds) => void;
}) {
  const map = useMap();
  useEffect(() => {
    if (!onBoundsChange) return;
    const report = () => {
      // A pane hidden by the mobile List/Map toggle measures 0×0, and Leaflet
      // fires `moveend` on that very transition (invalidateSize does, whenever
      // the size changed). getBounds() then collapses to a single point, which
      // would report a viewport containing nothing and empty the list. Keep the
      // last real viewport instead — it's the one the user was just looking at.
      const size = map.getSize();
      if (size.x === 0 || size.y === 0) return;
      const b = map.getBounds();
      onBoundsChange({
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
      });
    };
    map.on("moveend", report);
    return () => {
      map.off("moveend", report);
    };
  }, [map, onBoundsChange]);
  return null;
}

// Leaflet computes its pixel size once at init. When the map starts life inside
// a hidden pane (the mobile List/Map toggle uses display:none) it initializes at
// the wrong size and renders into a corner once shown. A ResizeObserver on the
// container fires when it goes from 0×0 to visible, and invalidateSize() makes
// Leaflet re-measure and repaint to fill the pane. It also keeps the map correct
// across window resizes on desktop.
//
// The same observer is the one place that knows whether the map currently
// occupies space, so it publishes that too: everything that has to wait for a
// real container waits on this one signal rather than measuring on its own.
function InvalidateOnResize({
  onVisibilityChange,
}: {
  onVisibilityChange: (visible: boolean) => void;
}) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    const measure = () => {
      map.invalidateSize();
      const size = map.getSize();
      onVisibilityChange(size.x > 0 && size.y > 0);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [map, onVisibilityChange]);
  return null;
}

// The place markers, grouped into clusters. A list here runs to several hundred
// places and every Leaflet marker is a pair of absolutely positioned images; a
// phone spends its frame budget compositing that layer instead of following the
// finger. Clustering is what keeps the number of drawn elements bounded no
// matter how far out the map is zoomed — which is exactly the case a viewport
// cull cannot help with, since framing a whole list puts every marker on screen
// at once.
//
// The group also drops markers outside the viewport from the DOM on its own
// (`removeOutsideVisibleBounds`, on by default), so it wants the full set handed
// to it once. Culling before it would only make it rebuild its index on every
// pan. `chunkedLoading` spreads that first insert across frames so a large list
// doesn't lock the main thread while it loads.
//
// Clustering also fixes something the old markers couldn't express: several
// places at the same address stacked into one pin with the rest unreachable
// underneath. Zooming into a cluster now spreads them apart.
function PlaceMarkers({ places }: { places: PlaceView[] }) {
  const withCoords = useMemo(
    () =>
      places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)),
    [places],
  );

  return (
    <MarkerClusterGroup chunkedLoading showCoverageOnHover={false}>
      {withCoords.map((p) => {
        const mapsUrl = googleMapsUrlFor(p);
        return (
          // Clicking the marker opens this popup (default Leaflet behaviour);
          // it no longer jumps straight to Google Maps. The popup body is the
          // link: clicking it opens Google Maps in a new tab.
          <Marker
            key={p.id}
            position={[p.lat as number, p.lng as number]}
            icon={icon}
          >
            <Popup>
              {mapsUrl ? (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block cursor-pointer no-underline"
                >
                  <strong>{p.title}</strong>
                  {p.address && <div className="text-gray-600">{p.address}</div>}
                  <div className="mt-1 text-xs font-medium text-blue-600">
                    Open in Google Maps ↗
                  </div>
                </a>
              ) : (
                <>
                  <strong>{p.title}</strong>
                  {p.address && <div className="text-gray-600">{p.address}</div>}
                </>
              )}
            </Popup>
          </Marker>
        );
      })}
    </MarkerClusterGroup>
  );
}

// Fly to the current location whenever the "My location" button is pressed
// (tracked by an incrementing tick), so the dot is brought into view even when
// it lies outside the area framed to the saved places.
function FlyToLocation({
  pos,
  tick,
}: {
  pos: [number, number] | null;
  tick: number;
}) {
  const map = useMap();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on tick
  useEffect(() => {
    if (tick > 0 && pos) map.flyTo(pos, 15, { duration: 0.6 });
  }, [map, tick]);
  return null;
}

export default function MapView({
  places,
  focus,
  onBoundsChange,
  location,
  frameKey,
}: MapViewProps) {
  const {
    pos: myPos,
    error: geoError,
    locate: locateMe,
    flyTick,
    overridden,
  } = location;
  // Whether the map's pane currently occupies space. False while the mobile
  // List tab is showing, which is also the state the map is born in.
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={[20, 0]}
        zoom={2}
        scrollWheelZoom
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <PlaceMarkers places={places} />
        {myPos && (
          <CircleMarker
            center={myPos}
            radius={8}
            pathOptions={{
              color: "#ffffff",
              weight: 3,
              fillColor: "#2563eb",
              fillOpacity: 1,
            }}
          >
            <Popup>{overridden ? "Showing places near here" : "You are here"}</Popup>
          </CircleMarker>
        )}
        <MapController
          places={places}
          focus={focus}
          visible={visible}
          frameKey={frameKey}
        />
        <FlyToLocation pos={myPos} tick={flyTick} />
        <BoundsReporter onBoundsChange={onBoundsChange} />
        <InvalidateOnResize onVisibilityChange={setVisible} />
      </MapContainer>

      <button
        type="button"
        onClick={locateMe}
        className="absolute right-3 top-3 z-[1000] rounded-md bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-md ring-1 ring-black/10 hover:bg-gray-50"
      >
        {/* Named plainly when it is not actually where the user is: the map is
            centred on a point from the URL, and calling that "my location"
            would be the one thing on screen that lies. */}
        📍 {overridden ? "Pinned point" : "My location"}
      </button>

      {geoError && (
        <div className="absolute bottom-3 left-3 z-[1000] max-w-xs rounded bg-red-600 px-3 py-2 text-xs text-white shadow-md">
          Location unavailable: {geoError}
        </div>
      )}
    </div>
  );
}
