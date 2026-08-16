import { redirect } from "next/navigation";
import { auth } from "@/auth";
import {
  ALL_PLACES_LIST_ID,
  loadListPlaces,
  loadListSummaries,
} from "@/lib/queries";
import Header from "./components/Header";
import Browser from "./components/Browser";

// The main three-column browser. It reads the database, so it must be dynamic.
export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  // Only the list that opens first travels with the page; the rest are fetched
  // when opened. An account here holds thousands of places across dozens of
  // lists, and sending all of them to render one was the bulk of the page.
  const lists = await loadListSummaries(session.user.id);
  // "All Places" opens first but is not rendered with the page: it is every
  // placed place in the account, which is the payload the split load exists to
  // keep off the wire. It arrives through the same fetch as any other list, so
  // the first screen is a spinner rather than megabytes of HTML.
  const first = lists[0];
  const preload = first && first.id !== ALL_PLACES_LIST_ID ? first : null;
  const initialPlaces = preload
    ? await loadListPlaces(session.user.id, preload.id)
    : [];

  return (
    <div className="flex h-screen flex-col">
      <Header />
      <Browser
        lists={lists}
        initialPlaces={initialPlaces}
        initialListId={preload?.id ?? null}
        placesUrl="/api/lists/{id}/places"
      />
    </div>
  );
}
