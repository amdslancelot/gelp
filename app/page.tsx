import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { loadListPlaces, loadListSummaries } from "@/lib/queries";
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
  const initialPlaces = lists[0]
    ? await loadListPlaces(session.user.id, lists[0].id)
    : [];

  return (
    <div className="flex h-screen flex-col">
      <Header />
      <Browser
        lists={lists}
        initialPlaces={initialPlaces}
        placesUrl="/api/lists/{id}/places"
      />
    </div>
  );
}
