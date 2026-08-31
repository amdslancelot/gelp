"use client";

import {
  googleMapsAppUrlFor,
  googleMapsUrlFor,
  type PlaceView,
} from "@/lib/place-view";

// Open a place in the Google Maps app, from the list row.
//
// This exists because the long-press menu on a row is Chrome's, not ours: its
// "View with Google Maps in Chrome" opens a web page, and no site can add an
// item to that menu. So the app is reached by a control of our own instead —
// which also leaves the browser's own text selection and address detection
// exactly as they are.
//
// How the app is actually reached differs by platform:
//
//   Android — an https maps link is a universal link, and the OS gives it to
//             the installed app without being asked. Navigating is enough.
//   iOS     — Chrome and Safari keep https maps links for themselves, so the
//             app is addressed directly through `comgooglemaps://`. That URL
//             does nothing at all when the app is not installed, so the https
//             link follows as a fallback if we are still on the page a moment
//             later. Leaving the page cancels it: `visibilityState` is
//             "hidden" once the app has taken over.
export default function OpenInMapsButton({
  place,
  className = "",
}: {
  place: PlaceView;
  className?: string;
}) {
  const webUrl = googleMapsUrlFor(place);
  // Nothing to open. A saved shopping item has no pin and no map page.
  if (!webUrl) return null;

  const open = (e: React.MouseEvent) => {
    // The row behind this is itself a button; without these the click would
    // also select the place and move the map's focus.
    e.stopPropagation();
    e.preventDefault();

    const isIOS =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      // iPadOS reports itself as a Mac, and is told apart by the touch points
      // a desktop Mac does not have.
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const appUrl = isIOS ? googleMapsAppUrlFor(place) : null;

    if (!appUrl) {
      window.open(webUrl, "_blank", "noopener,noreferrer");
      return;
    }

    // Same tab, deliberately: a scheme that no app answers would otherwise
    // leave an empty tab behind.
    window.location.href = appUrl;
    window.setTimeout(() => {
      if (document.visibilityState === "visible") window.location.href = webUrl;
    }, 1200);
  };

  return (
    <button
      type="button"
      onClick={open}
      title="Open in the Google Maps app"
      aria-label={`Open ${place.title} in the Google Maps app`}
      className={`shrink-0 rounded-full border border-neutral-300 bg-white p-1.5 shadow-sm transition hover:border-neutral-400 hover:bg-neutral-50 ${className}`}
    >
      {/* Google Maps' pin, in its four brand colours: the whole point of the
          button is being recognisable at a glance in the corner of a row. */}
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
        <path
          d="M12 2a7 7 0 0 0-7 7c0 5.25 7 13 7 13s7-7.75 7-13a7 7 0 0 0-7-7Z"
          fill="#34A853"
        />
        <path d="M5.6 5.2 12 9.9l4-3.4-5.2-4A7 7 0 0 0 5.6 5.2Z" fill="#FBBC04" />
        <path
          d="M12 22s-3.6-4-5.6-8.1L12 9.9 19 9c0 5.4-7 13-7 13Z"
          fill="#4285F4"
        />
        <path
          d="M15.9 2.9 12 9.9 5.6 5.2A7 7 0 0 1 15.9 2.9Z"
          fill="#EA4335"
        />
        <circle cx="12" cy="9" r="2.5" fill="#FFFFFF" />
      </svg>
    </button>
  );
}
