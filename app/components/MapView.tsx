"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { PlaceView } from "@/lib/queries";

// Fix Leaflet's default marker icons, whose relative URLs break under bundlers.
// CDN URLs sidestep the classic broken-image problem without asset config.
const icon = L.icon({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

interface MapViewProps {
  places: PlaceView[];
  // The place to pan/zoom to, if any.
  focus: PlaceView | null;
}

// Turn a raw GeolocationPositionError into an actionable message. The default
// browser strings (e.g. "Position update is unavailable") don't tell the user
// what to do about it.
function friendlyGeoError(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return "Permission denied — allow location access for this site in your browser.";
    case err.POSITION_UNAVAILABLE:
      return "Your device couldn't determine its location. On macOS, enable System Settings → Privacy & Security → Location Services (and turn Wi-Fi on), then retry.";
    case err.TIMEOUT:
      return "Timed out getting your location — try again.";
    default:
      return err.message;
  }
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
function MapController({ places, focus }: MapViewProps) {
  const map = useMap();

  useEffect(() => {
    if (focus && focus.lat != null && focus.lng != null) {
      map.flyTo([focus.lat, focus.lng], 16, { duration: 0.6 });
      return;
    }
    const withCoords = places.filter((p) => p.lat != null && p.lng != null);
    if (withCoords.length === 0) return;
    const bounds = L.latLngBounds(
      withCoords.map((p) => [p.lat as number, p.lng as number]),
    );
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
  }, [map, places, focus]);

  return null;
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

export default function MapView({ places, focus }: MapViewProps) {
  const withCoords = places.filter((p) => p.lat != null && p.lng != null);
  const [myPos, setMyPos] = useState<[number, number] | null>(null);
  const [flyTick, setFlyTick] = useState(0);
  const [geoError, setGeoError] = useState<string | null>(null);

  // Passively track location so the dot appears (and stays fresh) as soon as
  // permission is granted, without moving the map. Coarse accuracy is enough
  // for a "you are here" dot and succeeds more often on desktops than the
  // high-accuracy (GPS) provider. Errors here are silent — we don't nag before
  // the user asks; the button below surfaces them.
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        setMyPos([p.coords.latitude, p.coords.longitude]);
        setGeoError(null);
      },
      () => {},
      { enableHighAccuracy: false, maximumAge: 30_000 },
    );
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Explicit user gesture: request the position and fly the map to it. A gesture
  // also makes the browser permission prompt more reliable than an on-load one.
  const locateMe = useCallback(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoError("Geolocation is not supported by this browser.");
      return;
    }
    setGeoError(null);

    const onOk = (p: GeolocationPosition) => {
      setMyPos([p.coords.latitude, p.coords.longitude]);
      setGeoError(null);
      setFlyTick((t) => t + 1);
    };

    // Try precise (GPS) first, then fall back to coarse (network/Wi-Fi), which
    // frequently succeeds on desktops where the high-accuracy provider reports
    // POSITION_UNAVAILABLE.
    navigator.geolocation.getCurrentPosition(
      onOk,
      () => {
        navigator.geolocation.getCurrentPosition(
          onOk,
          (err) => setGeoError(friendlyGeoError(err)),
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
        );
      },
      { enableHighAccuracy: true, timeout: 8_000 },
    );
  }, []);

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
                    {p.address && (
                      <div className="text-gray-600">{p.address}</div>
                    )}
                    <div className="mt-1 text-xs font-medium text-blue-600">
                      Open in Google Maps ↗
                    </div>
                  </a>
                ) : (
                  <>
                    <strong>{p.title}</strong>
                    {p.address && (
                      <div className="text-gray-600">{p.address}</div>
                    )}
                  </>
                )}
              </Popup>
            </Marker>
          );
        })}
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
            <Popup>You are here</Popup>
          </CircleMarker>
        )}
        <MapController places={places} focus={focus} />
        <FlyToLocation pos={myPos} tick={flyTick} />
      </MapContainer>

      <button
        type="button"
        onClick={locateMe}
        className="absolute right-3 top-3 z-[1000] rounded-md bg-white px-3 py-2 text-sm font-medium text-gray-800 shadow-md ring-1 ring-black/10 hover:bg-gray-50"
      >
        📍 My location
      </button>

      {geoError && (
        <div className="absolute bottom-3 left-3 z-[1000] max-w-xs rounded bg-red-600 px-3 py-2 text-xs text-white shadow-md">
          Location unavailable: {geoError}
        </div>
      )}
    </div>
  );
}
