import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  ALL_PLACES_LIST_ID,
  loadSharedListPlaces,
  loadSharedMap,
} from "@/lib/queries";
import Browser from "@/app/components/Browser";

// Reads the database, and the token is per-request, so nothing here is static.
export const dynamic = "force-dynamic";

// A share link is meant to be passed to people, not found by them. Keeping it
// out of search indexes is the difference between "unlisted" and "public".
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// The public, read-only view of one user's map. No session is required — the
// token in the URL is the whole authority — so this page must render only what
// `loadSharedMap` returns and offer no way to change anything.
export default async function SharedMapPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const shared = await loadSharedMap(token);

  // A wrong, expired, or revoked token is a 404 either way: distinguishing them
  // would tell a stranger whether a token was ever real.
  if (!shared) notFound();

  // As on the owner's own page, only the first list travels with the HTML; the
  // rest are fetched through the token-authorised route as they are opened.
  // Except "All Places", which opens first and is the whole map: too much to
  // put in the HTML, so it comes through the token-authorised route like the
  // rest. Same rule as the owner's own page.
  const first = shared.lists[0];
  const preload = first && first.id !== ALL_PLACES_LIST_ID ? first : null;
  const initialPlaces = preload
    ? ((await loadSharedListPlaces(token, preload.id)) ?? [])
    : [];

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-white px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-xl font-bold tracking-tight text-emerald-800">
            Gelp
          </span>
          <span className="truncate text-sm text-neutral-500">
            {shared.ownerName ? `${shared.ownerName}'s places` : "Shared places"}
          </span>
        </div>
        <span className="shrink-0 rounded-full bg-neutral-100 px-2.5 py-1 text-[11px] font-medium text-neutral-500">
          Read-only
        </span>
      </header>
      <Browser
        lists={shared.lists}
        initialPlaces={initialPlaces}
        initialListId={preload?.id ?? null}
        placesUrl={`/api/s/${encodeURIComponent(token)}/places?list={id}`}
      />
    </div>
  );
}
