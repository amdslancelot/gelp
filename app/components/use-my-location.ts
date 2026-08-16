"use client";

import { useCallback, useEffect, useState } from "react";

// Where the user is, asked for once and shared by everything that needs it.
//
// It used to live inside MapView, which was fine while the only thing it moved
// was the map. It is now also what the first fetch is aimed at — the app opens
// on the places around you rather than on 2 MB of the whole account — and the
// fetch is started by Browser, above the map. So the position is owned here and
// passed down, rather than watched twice by two components that would then
// disagree about whether permission had been answered.

export interface MyLocation {
  pos: [number, number] | null;
  error: string | null;
  // True once the question has an answer — a position, a refusal, or a wait
  // long enough that we stop holding the map for it. The first load waits on
  // this and on nothing else.
  settled: boolean;
  // Ask again, from a user gesture, and report failure this time.
  locate: () => void;
  // Bumped each time `locate` succeeds, so the map can fly there on request
  // without flying there every time the watch reports a new fix.
  flyTick: number;
  // True when the position came from `?near=` rather than from the browser, so
  // the UI can say so — a map centred somewhere you are not is confusing only
  // if nothing admits it.
  overridden: boolean;
}

// How long the first load will wait for a position before giving up and asking
// for the whole list. Long enough for a permission prompt to be answered on a
// phone that is already warm, short enough that a user who ignores the prompt
// is not left looking at a spinner.
const FIRST_FIX_TIMEOUT_MS = 6_000;

// A position named in the page's own URL — `?near=25.033,121.565` — which
// stands in for the browser's answer entirely.
//
// Two things need it. The first is testing: a Mac with no GPS locates itself by
// scanning Wi-Fi, and when CoreLocation cannot (or the page is served over
// plain http on a LAN address, where no browser will even ask) there is no way
// to exercise the near-me path at all. The second is the reason it is worth
// keeping afterwards: "what have I saved near where I am going next week" is
// the same question as "near me", asked about somewhere else.
//
// Read once, on mount. Nothing here is server-rendered — the position only
// aims a fetch and moves a map, neither of which exists during SSR.
export function nearFromUrl(): [number, number] | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("near");
  if (!raw) return null;
  const [lat, lng] = raw.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return [lat, lng];
}

// How wide the first fetch reaches, when the URL says. Pairs with `near=`, but
// is read on its own so it can also widen a real geolocated fix: 50 km covers a
// city and its day trips, and someone asking about a whole metropolitan area is
// asking a different question, not a wrong one.
export function radiusFromUrl(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("radius");
  const km = Number(raw);
  // Bad values fall through to the default rather than erroring: the parameter
  // is a convenience, and the map is not worth failing over one.
  return Number.isFinite(km) && km > 0 ? Math.min(km, 20_000) : null;
}

export function useMyLocation(): MyLocation {
  // Read before the first effect runs, so an overridden position is in hand for
  // the very first fetch rather than one render later.
  const [override] = useState(nearFromUrl);
  const [pos, setPos] = useState<[number, number] | null>(override);
  const [error, setError] = useState<string | null>(null);
  // An override is its own answer: there is nothing to wait for.
  const [settled, setSettled] = useState(override !== null);
  const [flyTick, setFlyTick] = useState(0);

  // Ask on mount. This is a deliberate change from waiting for a tap: "open the
  // app and see what's around me" cannot be done after the fetch has already
  // been aimed somewhere else. A refusal costs nothing — `settled` flips and
  // the whole list is loaded, exactly as before.
  //
  // Coarse accuracy: a 50 km box does not need GPS, and the network provider
  // answers faster and more often — particularly on desktops, where the
  // high-accuracy provider frequently reports POSITION_UNAVAILABLE.
  useEffect(() => {
    // An overridden position is not a hint the browser gets to correct. Asking
    // anyway would prompt for a permission whose answer is about to be thrown
    // away, and a fix arriving later would quietly move the map off the place
    // the URL named.
    if (override) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setSettled(true);
      return;
    }

    // Nothing cancels a pending getCurrentPosition, so the timer is what makes
    // the wait bounded. It only ever sets `settled`: a fix arriving afterwards
    // is still used, it just no longer aims the first fetch.
    const timer = setTimeout(() => setSettled(true), FIRST_FIX_TIMEOUT_MS);

    const watchId = navigator.geolocation.watchPosition(
      (p) => {
        setPos([p.coords.latitude, p.coords.longitude]);
        setError(null);
        setSettled(true);
      },
      // Silent: the button below surfaces errors when the user asks. A denial
      // on load is an answer, not a failure worth a banner.
      () => setSettled(true),
      { enableHighAccuracy: false, maximumAge: 30_000 },
    );

    return () => {
      clearTimeout(timer);
      navigator.geolocation.clearWatch(watchId);
    };
  }, [override]);

  const locate = useCallback(() => {
    // With an override in the URL, the button means "take me back there".
    if (override) {
      setFlyTick((t) => t + 1);
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Geolocation is not supported by this browser.");
      return;
    }
    setError(null);

    const onOk = (p: GeolocationPosition) => {
      setPos([p.coords.latitude, p.coords.longitude]);
      setError(null);
      setSettled(true);
      setFlyTick((t) => t + 1);
    };

    // Precise (GPS) first, then coarse: this one is a user gesture asking to be
    // taken to where they are, so the extra second is worth the accuracy.
    navigator.geolocation.getCurrentPosition(
      onOk,
      () => {
        navigator.geolocation.getCurrentPosition(
          onOk,
          (err) => setError(friendlyGeoError(err)),
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
        );
      },
      { enableHighAccuracy: true, timeout: 8_000 },
    );
  }, [override]);

  return { pos, error, settled, locate, flyTick, overridden: override !== null };
}

// Turn a raw GeolocationPositionError into an actionable message. The default
// browser strings (e.g. "Position update is unavailable") don't tell the user
// what to do about it.
export function friendlyGeoError(err: GeolocationPositionError): string {
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
