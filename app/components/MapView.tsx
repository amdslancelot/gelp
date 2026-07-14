"use client";

import { useEffect } from "react";
import {
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

export default function MapView({ places, focus }: MapViewProps) {
  const withCoords = places.filter((p) => p.lat != null && p.lng != null);

  return (
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
          <Marker
            key={p.id}
            position={[p.lat as number, p.lng as number]}
            icon={icon}
            eventHandlers={
              mapsUrl
                ? {
                    click: () => {
                      window.open(mapsUrl, "_blank", "noopener,noreferrer");
                    },
                  }
                : undefined
            }
          >
            <Popup>
              <strong>{p.title}</strong>
              {p.address && <div>{p.address}</div>}
            </Popup>
          </Marker>
        );
      })}
      <MapController places={places} focus={focus} />
    </MapContainer>
  );
}
